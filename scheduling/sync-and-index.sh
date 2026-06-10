#!/bin/bash
# retrieval-skill periodic mirror + index pipeline
# Runs mirror sync, then indexes each mirrored adapter directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="/tmp/retrieval-skill-sync.lock"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"

# ── Node resolution ──────────────────────────────────────────────────────────
# CRITICAL: the native better-sqlite3 binary is compiled against ONE Node ABI.
# The scheduler must use the SAME node that better-sqlite3 was built for, or every
# index step crashes with NODE_MODULE_VERSION mismatch (silent staleness — the bug
# that left slack+mono 6.5 days stale, 2026-06-10). We pin to Homebrew node
# (the interactive default that `npm rebuild` / `node src/cli.mjs list` use) and do
# NOT let mise shims override it. RETRIEVAL_NODE_BIN env var can override the pin.
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
export PATH
NODE_BIN="${RETRIEVAL_NODE_BIN:-/opt/homebrew/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "$LOG_PREFIX ERROR: node not found"; exit 1; }
export NODE_BIN
node() { "$NODE_BIN" "$@"; }   # all `node ...` calls below use the pinned binary
echo "$LOG_PREFIX Using node $("$NODE_BIN" -v) (ABI $("$NODE_BIN" -p process.versions.modules)) at $NODE_BIN"

if [ -f "$REPO_DIR/.env.local" ]; then
  set -a; source "$REPO_DIR/.env.local"; set +a
fi
if [ -f "$REPO_DIR/.env" ]; then
  set -a; source "$REPO_DIR/.env"; set +a
fi

OUTPUT_DIR="${RETRIEVE_MIRROR_OUTPUT:-$REPO_DIR/data}"
INDEX_PREFIX="${RETRIEVE_INDEX_PREFIX:-}"

# Route embeddings DIRECTLY at the Octen MLX server, NOT the Ohm proxy on :4000.
# The Ohm proxy enforces a request-body buffer limit that real slack/mono batches
# exceed (HTTP 413 "Failed to buffer the request body: length limit exceeded"),
# which silently failed slack+mono indexing. The kindo-repo-* scripts already use
# this direct route; the scheduler now matches that proven convention.
export EMBEDDING_SERVER_URL="${EMBEDDING_SERVER_URL:-http://localhost:8100}"

# ── better-sqlite3 ABI self-heal ──────────────────────────────────────────
# If the native module was built for a different Node ABI than $NODE_BIN, the
# index step crashes (NODE_MODULE_VERSION). Detect it up front and auto-rebuild
# instead of failing silently every run.
if ! "$NODE_BIN" -e 'new (require("better-sqlite3"))("/tmp/.retrieval-abi-probe.db").close()' >/dev/null 2>&1; then
  echo "$LOG_PREFIX better-sqlite3 ABI mismatch for $("$NODE_BIN" -v) — rebuilding..."
  rm -f /tmp/.retrieval-abi-probe.db
  if PATH="$(dirname "$NODE_BIN"):$PATH" npm rebuild better-sqlite3 2>&1 \
     && "$NODE_BIN" -e 'new (require("better-sqlite3"))("/tmp/.retrieval-abi-probe.db").close()' >/dev/null 2>&1; then
    echo "$LOG_PREFIX better-sqlite3 rebuilt successfully for $("$NODE_BIN" -v)"
  else
    echo "$LOG_PREFIX FATAL: better-sqlite3 rebuild failed — indexing cannot proceed (indexes will go stale!)"
    exit 1
  fi
fi
rm -f /tmp/.retrieval-abi-probe.db

if [ -f "$LOCK_FILE" ]; then
  LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if [ -n "${LOCK_PID:-}" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "$LOG_PREFIX Skipping — previous run still active (PID $LOCK_PID)"
    exit 0
  fi
  rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

echo "$LOG_PREFIX Starting retrieval-skill sync + index"
cd "$REPO_DIR"

if node src/cli.mjs mirror sync --output "$OUTPUT_DIR" 2>&1; then
  echo "$LOG_PREFIX Mirror sync completed"
else
  echo "$LOG_PREFIX Mirror sync completed with errors (continuing to indexing)"
fi

# Health check: accept Ohm's {"status":"ok"} or Octen's {"status":"ok"/"healthy"} or deep {"embed_check":"ok"}
HEALTH=$(curl -s "http://localhost:4000/health" 2>/dev/null || curl -s "http://localhost:8100/health" 2>/dev/null)
if echo "$HEALTH" | grep -qE '"status"\s*:\s*"(ok|healthy)"'; then
  echo "$LOG_PREFIX Embedding server healthy (via Ohm or Octen)"
elif echo "$HEALTH" | grep -q '"embed_check":"ok"'; then
  echo "$LOG_PREFIX Embedding server healthy (deep check)"
else
  echo "$LOG_PREFIX Skipping indexing (embedding server not healthy: $HEALTH)"
  exit 0
fi

FAILED_ADAPTERS=()
for adapter in slack notion linear; do
  ADAPTER_DIR="$OUTPUT_DIR/$adapter"
  if [ -d "$ADAPTER_DIR" ]; then
    INDEX_NAME="${INDEX_PREFIX}${adapter}"
    echo "$LOG_PREFIX Indexing $adapter -> $INDEX_NAME"
    if ! node src/cli.mjs index "$ADAPTER_DIR" --name "$INDEX_NAME" 2>&1; then
      echo "$LOG_PREFIX ❌ ERROR: $adapter indexing FAILED"
      FAILED_ADAPTERS+=("$adapter")
    fi
  fi
done

# ── Git-repo indexes (mono, etc.) ─────────────────────────────────────
# RETRIEVE_GIT_REPOS (set in .env) is a comma-separated list of name:path entries,
# e.g. "mono:$HOME/code/mono". These are local git checkouts indexed in place via
# `reindex` (content-addressed, so unchanged files are skipped cheaply). Previously
# this env var was DEAD config — nothing read it — which is why the mono index was
# never refreshed by the scheduler and silently went stale (2026-06-10). Now wired up.
GIT_REPOS="${RETRIEVE_GIT_REPOS:-}"
GIT_INDEX_NAMES=()
if [ -n "$GIT_REPOS" ]; then
  IFS=',' read -ra _REPO_ENTRIES <<< "$GIT_REPOS"
  for entry in "${_REPO_ENTRIES[@]}"; do
    name="${entry%%:*}"; repo_path="${entry#*:}"
    repo_path="$(eval echo "$repo_path")"   # expand $HOME etc.
    [ -z "$name" ] && continue
    GIT_INDEX_NAMES+=("$name")
    if [ -d "$repo_path" ]; then
      echo "$LOG_PREFIX Reindexing git repo $name ($repo_path)"
      if ! node src/cli.mjs reindex "$name" 2>&1; then
        echo "$LOG_PREFIX ❌ ERROR: $name reindex FAILED"
        FAILED_ADAPTERS+=("$name")
      fi
    else
      echo "$LOG_PREFIX ⚠ git repo path missing for $name: $repo_path (skipping)"
    fi
  done
fi

# ── Loud failure + staleness summary ─────────────────────────────────────
# Surfaces silent failures: if any tracked index is >24h stale OR an adapter
# errored this run, print a clearly-greppable banner so the problem is visible
# in the log (and to any future staleness monitor) instead of failing quietly.
echo "$LOG_PREFIX === Index freshness ==="
TRACKED_LIST="slack notion linear ${GIT_INDEX_NAMES[*]:-}"
RETRIEVAL_TRACKED="$TRACKED_LIST" node -e '
  const Database = require("better-sqlite3");
  const os = require("os"), path = require("path");
  const idxDir = path.join(os.homedir(), ".retrieval-skill", "indexes");
  const tracked = (process.env.RETRIEVAL_TRACKED || "slack notion linear").trim().split(/\s+/).filter(Boolean);
  const STALE_MS = 24 * 3600 * 1000;
  let stale = [];
  for (const n of tracked) {
    try {
      const db = new Database(path.join(idxDir, n + ".db"), { readonly: true });
      const ts = db.prepare("SELECT value FROM meta WHERE key=?").get("last_indexed_at")?.value;
      db.close();
      const ageH = ts ? ((Date.now() - Date.parse(ts)) / 3600000).toFixed(1) : "n/a";
      const flag = (!ts || Date.now() - Date.parse(ts) > STALE_MS) ? " STALE" : "";
      if (flag) stale.push(n);
      console.log(`    ${n.padEnd(8)} last_indexed=${ts || "never"} (${ageH}h ago)${flag}`);
    } catch (e) { console.log(`    ${n.padEnd(8)} ERROR reading index: ${e.message}`); stale.push(n); }
  }
  if (stale.length) { console.log(`STALENESS-ALERT: ${stale.join(",")} index(es) >24h old or unreadable`); process.exitCode = 0; }
' 2>&1 || echo "$LOG_PREFIX (freshness check failed to run)"

if [ ${#FAILED_ADAPTERS[@]} -gt 0 ]; then
  echo "$LOG_PREFIX === SYNC-FAILURE: adapters failed this run: ${FAILED_ADAPTERS[*]} ==="
  echo "$LOG_PREFIX Done (with errors)"
  exit 1
fi

echo "$LOG_PREFIX Done"
