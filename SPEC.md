# SPEC: Generic Retrieval Skill — Incremental Indexing & Hybrid Search

**Status:** 🟡 In Progress
**Repo:** `~/personal/retrieval-skill` → `github.com/c-h-/retrieval-skill` (private)
**Branch:** `main`

---

## Overview

Build a production-quality generic retrieval system: incremental indexing of any directory into a SQLite vector store, with hybrid FTS5 + cosine search. This will become an OpenClaw skill for autonomous agent search across Slack, Linear, Gmail, Notion, and any other indexed content.

**Key decisions from Charlie:**
- Use the **best quality open-weights embedding model** (not BGE-small). Research leaderboard and pick the best that runs locally on Apple Silicon (512GB RAM Mac Studio).
- Each saas-mirror adapter gets its own **top-level index** (e.g., `linear`, `slack`, `gog`, `notion`) — not one unified index.
- **Multi-index search** supported: `retrieve search --index linear,slack "auth flow"`
- Triggering/scheduling will be figured out later — keep indexing and search **loosely coupled** from saas-mirror.
- This will be an **OpenClaw skill** as its primary purpose — agents call `retrieve search` autonomously.
- Start with best quality model. We have a powerful machine.

---

## 1. Prior Art (Reference Implementation)

The existing prototype lives at `~/.openclaw/skills/retrieve/` — a working but limited system built for cookbook recipes. See the old `SPEC-retrieve.md` in saas-mirror for full gap analysis. Key pieces to carry forward:
- SQLite + FTS5 + vectors as BLOBs (zero-infra, portable)
- Hybrid search concept (FTS + cosine)
- Local ONNX model inference via `@xenova/transformers`

The existing prototype's model (`Xenova/bge-small-en-v1.5`, 33MB) and scripts should be referenced but NOT copied. Build fresh.

---

## 2. Phase 0: Embedding Model Research

Before writing code, research and select the best local embedding model:

- [x] Check MTEB leaderboard for top open-weights embedding models
- [x] Filter for models that run on Apple Silicon (ONNX or MLX)
- [x] Compare: dimensions, max tokens, MTEB retrieval score, model size
- [x] Consider: `nomic-embed-text-v1.5`, `bge-large-en-v1.5`, `e5-large-v2`, `gte-large`, `mxbai-embed-large`, or newer models
- [x] Check if `@xenova/transformers` supports the chosen model (ONNX), or if we need `mlx` runtime
- [x] Document the choice and reasoning in this spec before proceeding

**Constraint:** Must run locally, no API calls. Quality > speed (we have a Mac Studio).

### Model Decision: `Snowflake/snowflake-arctic-embed-l`

| Property | Value |
|---|---|
| **HuggingFace ID** | `Snowflake/snowflake-arctic-embed-l` |
| **Parameters** | 335M |
| **Dimensions** | 1024 |
| **Max Tokens** | 512 |
| **MTEB Retrieval nDCG@10** | **55.98** (highest among ONNX-compatible models) |
| **Runtime** | `@huggingface/transformers` (ONNX) |
| **Pooling** | CLS token |
| **Query Prefix** | `"Represent this sentence for searching relevant passages: "` |
| **Document Prefix** | None |
| **License** | Apache-2.0 |

**Why this model:**
1. Highest retrieval-specific score (55.98 nDCG@10) among all models with confirmed transformers.js/ONNX compatibility
2. ONNX weights available directly in the HuggingFace repo, tagged for transformers.js
3. 1024-dim embeddings provide rich semantic representations
4. 512 max tokens aligns perfectly with our chunking strategy
5. Apache-2.0 license, fully permissive

**Runners-up considered:** mxbai-embed-large-v1 (54.39), bge-large-en-v1.5 (54.29), nomic-embed-text-v1.5 (~49). Arctic-embed-l-v2.0 was rejected due to a known transformers.js bug (issue #1326) and slightly lower retrieval score.

---

## 3. Schema (SQLite)

```sql
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  metadata TEXT  -- JSON: frontmatter fields, source info
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  section_context TEXT,  -- e.g., "Issue ENG-1234 | Comments"
  UNIQUE(file_id, chunk_index)
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content, file_path, content_rowid='id'
);

CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(content_hash);
```

---

## 4. Incremental Indexing

Change detection per file:
1. **mtime fast path** — unchanged mtime → SKIP
2. **SHA-256 content hash** — mtime changed but content same → update mtime, SKIP
3. **Content changed** → delete old chunks (CASCADE), re-chunk, embed new chunks, insert
4. **Dead file pruning** — DB entries for files no longer on disk get deleted

Content-addressed chunk caching: `content_hash = SHA-256(chunk_content + model_id)`. Same content with same model = reuse embedding.

---

## 5. Markdown-Aware Chunking

1. Parse YAML frontmatter → extract as file metadata (NOT included in chunks)
2. Split on markdown headers (`##`, `###`) as natural section boundaries
3. Within sections, split on paragraph boundaries (`\n\n`)
4. Merge small paragraphs up to target chunk size (~512 tokens for the chosen model's max)
5. Oversized sections: split at sentence boundaries with overlap
6. Each chunk gets a **context prefix** from document title + section header

---

## 6. CLI Interface

```bash
# Unified CLI
node src/cli.mjs <command> [options]

# Index a directory
retrieve index <directory> [--name <index-name>] [--model <model-alias>]

# Search (single or multi-index)
retrieve search <query> --index <name>[,<name>...] [--top-k <n>] [--threshold <score>] [--json]

# List all indexes
retrieve list

# Show index status
retrieve status <index-name>

# Delete an index
retrieve delete <index-name>
```

**Index naming convention for saas-mirror:**
```bash
retrieve index ~/personal/saas-mirror/data/linear --name linear
retrieve index ~/personal/saas-mirror/data/slack --name slack
retrieve index ~/personal/saas-mirror/data/gog --name gog
retrieve index ~/personal/saas-mirror/data/notion --name notion
```

**Multi-index search:**
```bash
retrieve search "auth token refresh" --index linear,slack,gog
retrieve search "meeting notes" --index slack --top-k 10
```

---

## 7. Search Pipeline

```
1. Embed query with index's model
2. FTS5 keyword search → top 100 candidates per index
3. Cosine similarity on FTS candidates → re-rank
4. Pure vector scan on recent/random sample → catch semantic-only matches
5. Merge across indexes, deduplicate, final top-K
6. Return: content, score, file path, section context, metadata
```

Output format (default: human-readable, `--json` for programmatic):
```
[0.847] linear/issues/ENG/ENG-1234.md § Comments
  "The auth token refresh was failing because the middleware..."
  
[0.823] slack/channels/engineering/messages.md § 2026-02-10
  "Charlie mentioned we need to handle the OAuth refresh..."
```

---

## 8. Project Structure

```
~/personal/retrieval-skill/
├── src/
│   ├── cli.mjs          # CLI dispatcher
│   ├── index.mjs        # Indexing engine
│   ├── search.mjs       # Search engine  
│   ├── chunker.mjs      # Markdown-aware chunking
│   ├── embedder.mjs     # Model loading + embedding
│   ├── schema.mjs       # SQLite schema + migrations
│   └── utils.mjs        # Hashing, file walking, etc.
├── __tests__/
│   ├── chunker.test.mjs
│   ├── index.test.mjs
│   ├── search.test.mjs
│   └── fixtures/        # Sample .md files for testing
├── indexes/             # SQLite index DBs (gitignored)
├── models/              # ONNX/MLX model files (gitignored)
├── SPEC.md
├── README.md
├── package.json
├── .gitignore
└── vitest.config.mjs    # or similar test config
```

---

## 9. Implementation Phases

### Phase 0: Model Research (~30 min)
- [ ] Research MTEB leaderboard for best open-weights embedding model
- [ ] Verify it runs locally (ONNX via @xenova/transformers, or MLX)
- [ ] Document choice in this spec
- [ ] Download model

### Phase 1: Core Infrastructure (~3 hrs)
- [ ] Project setup: package.json, dependencies, .gitignore
- [ ] SQLite schema with migrations
- [ ] File walker (recursive, filtered by extension)
- [ ] Content hashing (SHA-256)
- [ ] Incremental change detection
- [ ] Embedder module (model loading, batch embedding)

### Phase 2: Chunking (~2 hrs)
- [ ] YAML frontmatter parser
- [ ] Markdown header splitter
- [ ] Paragraph-boundary chunker with merge
- [ ] Context prefix generation
- [ ] Tests with fixture files

### Phase 3: Indexing CLI (~2 hrs)
- [ ] `index` command: walk → detect changes → chunk → embed → store
- [ ] `list` command
- [ ] `status` command  
- [ ] `delete` command
- [ ] Progress reporting during indexing

### Phase 4: Search (~2 hrs)
- [ ] `search` command with FTS pre-filter → cosine re-rank
- [ ] Multi-index search (merge results across DBs)
- [ ] `--json` output for programmatic use
- [ ] `--threshold` filtering
- [ ] Human-readable output with context

### Phase 5: E2E Testing (~2 hrs)
- [ ] Index `~/personal/saas-mirror/data/linear` → verify index created
- [ ] Index `~/personal/saas-mirror/data/slack` → verify
- [ ] Search across both: `retrieve search "auth" --index linear,slack`
- [ ] Incremental test: modify a file, re-index, verify only that file re-embedded
- [ ] Unit tests for chunker, hasher, change detection
- [ ] Document results in README

### Phase 6: Ship (~30 min)
- [ ] README with full usage docs
- [ ] Commit and push to `c-h-/retrieval-skill`
- [ ] Verify tests pass

---

## 10. Key Context

- **Repo:** `~/personal/retrieval-skill` → `github.com/c-h-/retrieval-skill` (private)
- **Git author:** `Doink (OpenClaw) <charlie+doink@kindo.ai>` + `Co-Authored-By: Charlie Hulcher <charlie@kindo.ai>`
- **Use `gh-me`** (NOT `gh`) for any GitHub CLI operations
- **Test data:** `~/personal/saas-mirror/data/{linear,slack,gog,notion}` — use for E2E testing
- **Reference implementation:** `~/.openclaw/skills/retrieve/` — read for patterns but build fresh
- **Machine:** Mac Studio, Apple Silicon, 512GB RAM — use best quality model
- **Node.js ESM** — use `.mjs` extensions, `import` not `require`
- **Dependencies:** `better-sqlite3`, `@xenova/transformers` (or MLX if better model needs it), `yaml`, `commander`, `vitest`
- **After this works E2E:** We'll install it as an OpenClaw skill at `~/.openclaw/skills/retrieve/`
