#!/bin/bash
# retrieval-skill periodic mirror + index pipeline
# Runs mirror sync, then indexes each mirrored adapter directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="/tmp/retrieval-skill-sync.lock"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')]"

for p in \
  "$HOME/.local/share/mise/shims" \
  "$HOME/.local/bin" \
  "$HOME/.nvm/versions/node/"*/bin \
  "/opt/homebrew/bin" \
  "/usr/local/bin"; do
  [ -d "$p" ] && export PATH="$p:$PATH"
done

command -v node >/dev/null || { echo "$LOG_PREFIX ERROR: node not found"; exit 1; }

if [ -f "$REPO_DIR/.env.local" ]; then
  set -a; source "$REPO_DIR/.env.local"; set +a
fi
if [ -f "$REPO_DIR/.env" ]; then
  set -a; source "$REPO_DIR/.env"; set +a
fi

OUTPUT_DIR="${RETRIEVE_MIRROR_OUTPUT:-$REPO_DIR/data}"
INDEX_PREFIX="${RETRIEVE_INDEX_PREFIX:-}"

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

if ! curl -s -o /dev/null -w '%{http_code}' http://localhost:8100/v1/embeddings \
  -X POST -H "Content-Type: application/json" \
  -d '{"input":"healthcheck","model":"Octen-Embedding-8B"}' | grep -q "200"; then
  echo "$LOG_PREFIX Skipping indexing (embedding server not running on :8100)"
  exit 0
fi

for adapter in slack notion linear gog; do
  ADAPTER_DIR="$OUTPUT_DIR/$adapter"
  if [ -d "$ADAPTER_DIR" ]; then
    INDEX_NAME="${INDEX_PREFIX}${adapter}"
    echo "$LOG_PREFIX Indexing $adapter -> $INDEX_NAME"
    node src/cli.mjs index "$ADAPTER_DIR" --name "$INDEX_NAME" 2>&1 || echo "$LOG_PREFIX Warning: $adapter indexing failed"
  fi
done

echo "$LOG_PREFIX Done"
