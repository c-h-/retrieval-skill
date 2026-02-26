# AGENTS.md

Developer documentation for contributing to retrieval-skill.

## Architecture overview

retrieval-skill is a Node.js CLI tool (ES modules, `.mjs`) that indexes documents into SQLite databases and provides hybrid search. No build step — source files in `src/` are the runtime.

### Directory structure

```
src/
├── cli.mjs                  # CLI entry point (Commander.js)
├── index.mjs                # Text indexing: walk files, chunk, embed, store
├── vision-index.mjs         # Vision indexing: PDF → page images → embed, store
├── search.mjs               # Hybrid search: vector + FTS5 + vision + RRF fusion
├── schema.mjs               # SQLite schema, migrations (v1→v4), openDb()
├── chunker.mjs              # Markdown parsing: frontmatter, sections, chunks
├── gog-chunker.mjs          # Email (gog) chunking: thread splitting, HTML strip, dedup
├── embedder.mjs             # Octen embedding server client (HTTP)
├── utils.mjs                # sha256, chunkHash, walkFiles, readFileContent
├── adapters/
│   ├── adapter.mjs          # Adapter interface, registry (register/get/list)
│   ├── text-adapter.mjs     # Octen-8B text adapter (wraps embedder.mjs)
│   └── vision-adapter.mjs   # ColQwen2.5 vision adapter (wraps bridge.mjs)
├── search/
│   └── maxsim.mjs           # ColBERT-style MaxSim scoring for vision search
└── vision/
    ├── bridge.mjs            # Node.js ↔ Python subprocess bridge (JSON-RPC)
    ├── server.py             # PyTorch+MPS vision embedding server
    ├── server_mlx.py         # Apple MLX vision embedding server
    ├── benchmark.py          # Backend performance comparison
    ├── requirements.txt      # PyTorch dependencies
    ├── requirements-mlx.txt  # MLX dependencies
    ├── setup.sh              # PyTorch venv setup script
    └── setup-mlx.sh          # MLX venv setup script
```

### Data flow

**Text indexing:** `cli.mjs` → `index.mjs` → `chunker.mjs` (or `gog-chunker.mjs` for email) + `embedder.mjs` → `schema.mjs` (SQLite)

**Vision indexing:** `cli.mjs` → `vision-index.mjs` → `vision-adapter.mjs` → `bridge.mjs` → `server.py`/`server_mlx.py`

**Search:** `cli.mjs` → `search.mjs` → `embedder.mjs` (query) + SQLite (FTS5 + vector scan) + `maxsim.mjs` (vision) → RRF fusion

### SQLite schema (v4)

Each index is an independent `.db` file in `~/.retrieval-skill/indexes/`.

- `meta` — key-value store (schema_version, source_directory, model_id, etc.)
- `files` — indexed files with content_hash and mtime for incremental updates
- `chunks` — text chunks with embeddings (BLOB), section_context, content_timestamp_ms
- `chunks_fts` — contentless FTS5 virtual table for keyword search
- `page_images` — vision: PDF page metadata with image_hash for dedup
- `page_vectors` — vision: multi-vector embeddings per page (128-dim each)

Migrations are forward-only and additive (new tables/columns, no drops).

## How adapters work

Adapters provide a uniform interface for embedding models. The registry in `src/adapters/adapter.mjs` manages them.

**Required interface:**
- `name` (string) — unique identifier
- `type` ('text' | 'vision') — determines available methods
- `init()` — async initialization (load model, start subprocess, etc.)
- `embedQuery(query)` — returns Float32Array (text) or Float32Array[] (vision)
- `embeddingDim()` — dimension of output vectors
- `modelId()` — model identifier string
- `dispose()` — cleanup resources

**Text adapters** additionally implement `embedDocuments(texts)`.
**Vision adapters** additionally implement `embedImages(imagePaths)`.

The registry validates adapters on registration and rejects invalid ones.

## How to build and test

```bash
npm install        # Install dependencies
npm test           # Run all tests (vitest)
npm run test:watch # Watch mode
```

No build step required — the project uses pure ES modules (.mjs).

### Test structure

```
__tests__/
├── adapter.test.mjs       # Adapter interface validation, registry operations
├── chunker.test.mjs       # Markdown parsing, frontmatter, section splitting
├── gog-chunker.test.mjs   # Email chunking: thread split, HTML strip, dedup, integration
├── maxsim.test.mjs        # MaxSim scoring math (cosine, identity, scaling)
├── recency.test.mjs       # Timestamp extraction, recency boost, relative age
├── schema-vision.test.mjs # Vision schema tables, cascade delete, migrations
├── utils.test.mjs         # sha256, chunkHash, walkFiles
├── vision-e2e.test.mjs    # End-to-end PDF indexing + search (skipped if no PDF)
└── fixtures/
    ├── no-frontmatter.md  # Markdown without YAML front matter
    ├── sample-issue.md    # Linear issue format
    └── sample-thread.md   # Slack thread format
```

E2E vision tests require a PDF file and Python vision backend — they are skipped automatically if not available.

## Key design decisions

**SQLite over Postgres/Redis** — Single-file databases, zero infrastructure, portable. WAL journaling for concurrent reads. Content-addressed dedup at the chunk level.

**Contentless FTS5** — The FTS index doesn't store content (saves ~50% space). Deletion uses the special `INSERT INTO fts VALUES('delete', ...)` syntax instead of `DELETE`.

**Brute-force vector search** — No HNSW or IVF index. For <100K chunks, a full scan with dot product is fast enough (~10ms). Keeps the system simple.

**Python subprocess for vision** — ColQwen2.5 requires PyTorch/MLX which don't have good Node.js bindings. JSON-RPC over stdin/stdout avoids HTTP overhead while keeping the boundary clean.

**Dual vision backends** — PyTorch+MPS for indexing (faster on images), MLX for queries (faster on text). Users pick via `VISION_BACKEND` env var.

**RRF over learned fusion** — Reciprocal Rank Fusion is parameter-free (k=60 constant) and works well across heterogeneous score scales. No training data needed.

**Recency as a multiplicative boost** — Preserves the semantic ranking while gently favoring recent content. Weight of 0.15 means recency is 15% of the final score. Null timestamps get no penalty.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_SERVER_URL` | Text embedding server endpoint | `http://localhost:8100` |
| `VISION_BACKEND` | Vision backend: `torch` or `mlx` | `torch` |

## Code conventions

- Pure ES modules (`.mjs`), no TypeScript, no build step
- Functions over classes (except `VisionBridge`)
- Synchronous SQLite via `better-sqlite3` (no async DB overhead)
- Errors to stderr (`console.error`), data to stdout (`console.log`)
- Tests via vitest, Jest-compatible API
