# retrieval-skill

Generic retrieval system: incremental indexing + hybrid FTS5/cosine search. Powers semantic search across Slack, Notion, Linear, Gmail, and code repos for [OpenClaw](https://github.com/orgloop) agents.

## What it does

retrieval-skill indexes directories of markdown files (and PDFs) into SQLite databases, then provides hybrid search combining:

- **Vector similarity** (60%) — cosine similarity via [Octen-Embedding-8B](https://huggingface.co/Octen/Octen-Embedding-8B) (4096-dim)
- **FTS5 keyword matching** (40%) — SQLite full-text search with BM25 ranking
- **Vision embeddings** — [ColQwen2.5](https://huggingface.co/tsystems/colqwen2.5-3b-multilingual-v1.0-merged) multi-vector page embeddings for PDF retrieval
- **Recency boost** — time-aware scoring with configurable half-life decay
- **RRF fusion** — Reciprocal Rank Fusion across text, keyword, and vision search lanes

Indexing is incremental: content-addressed deduplication, mtime checking, and chunk-level caching ensure fast re-indexing.

## Architecture

```
Markdown/PDF Files
        │
        ├─── Text Pipeline ──────────────────────────────┐
        │    walkFiles() → chunkDocument()                │
        │    → Octen-8B embeddings (4096-dim)             │
        │    → SQLite: files, chunks, chunks_fts          │
        │                                                 │
        ├─── Vision Pipeline ────────────────────────────┐│
        │    extractPages() (PDF → PNG)                  ││
        │    → ColQwen2.5 multi-vector (128-dim × ~700)  ││
        │    → SQLite: page_images, page_vectors         ││
        │                                                ││
        └─── Hybrid Search ──────────────────────────────┘│
             FTS5 candidates → vector scoring             │
             + MaxSim vision scoring                      │
             → RRF fusion → recency boost → top-K         │
```

Each index is a self-contained SQLite database stored in `~/.retrieval-skill/indexes/`.

## Installation

```bash
npm install -g retrieval-skill
```

**Requirements:**
- Node.js >= 18.0.0
- An embedding server running at `http://localhost:8100` (OpenAI-compatible API, e.g. [Octen-Embedding-8B](https://huggingface.co/Octen/Octen-Embedding-8B) via MLX)

**For vision features (optional):**
- Python >= 3.10
- PyTorch + MPS backend, or Apple MLX

Set up the vision backend:

```bash
# PyTorch (default)
cd src/vision && bash setup.sh

# Or MLX (faster for queries on Apple Silicon)
cd src/vision && bash setup-mlx.sh
```

## Quick start

```bash
# Index a directory of markdown files
retrieve index ./slack-export --name slack

# Search across indexes
retrieve search "authentication flow" --index slack

# Search multiple indexes
retrieve search "onboarding checklist" --index slack,notion,linear

# Index a PDF with vision embeddings
retrieve index-vision ./cookbook.pdf --name cookbook

# Hybrid search (text + vision)
retrieve search "chocolate cake recipe" --index cookbook --mode hybrid

# Output as JSON for programmatic use
retrieve search "API design" --index linear --json
```

## CLI reference

### `retrieve index <directory>`

Index a directory of markdown files (`.md`, `.markdown`, `.txt`).

```bash
retrieve index ./data/slack-export --name slack
```

| Option | Description | Default |
|--------|-------------|---------|
| `--name <name>` | Index name | Directory basename |

Outputs JSON stats on completion: files processed, chunks created, embeddings cached.

### `retrieve index-vision <pdf>`

Index a PDF using vision embeddings (ColQwen2.5 multi-vector).

```bash
retrieve index-vision ./recipes.pdf --name recipes --batch-size 4
```

| Option | Description | Default |
|--------|-------------|---------|
| `--name <name>` | Index name | PDF filename (without `.pdf`) |
| `--batch-size <n>` | Pages per embedding batch | `2` |

### `retrieve search <query>`

Search across one or more indexes.

```bash
retrieve search "quarterly OKRs" --index linear,notion --top-k 5 --json
```

| Option | Description | Default |
|--------|-------------|---------|
| `--index <names>` | Comma-separated index names | **(required)** |
| `--top-k <n>` | Number of results | `10` |
| `--threshold <score>` | Minimum score threshold | `0` |
| `--mode <mode>` | `text`, `vision`, or `hybrid` | `text` |
| `--recency-weight <n>` | Recency weight (0 disables) | `0.15` |
| `--half-life <days>` | Recency half-life in days | `90` |
| `--json` | Output as JSON | off |

### `retrieve list`

List all available indexes with metadata.

```bash
retrieve list
```

### `retrieve status <name>`

Show detailed status of an index (files, chunks, model, timestamps).

```bash
retrieve status slack
```

### `retrieve delete <name>`

Delete an index and its database file.

```bash
retrieve delete old-export
```

## Supported index sources

retrieval-skill is source-agnostic — it indexes any directory of markdown files. Timestamp extraction is built in for common export formats:

| Source | Timestamp field | Format |
|--------|----------------|--------|
| Notion | `last_edited_time` | ISO 8601 |
| Linear | `updatedAt` | ISO 8601 |
| Slack | `ts` | Unix epoch (seconds) |
| Mono | `updated_at` | ISO 8601 |
| Generic | `date`, `created`, `timestamp` | ISO 8601 or Unix |

Timestamps power the recency boost — recent content scores higher in search results.

## Configuration

All configuration is via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_SERVER_URL` | Text embedding server URL | `http://localhost:8100` |
| `VISION_BACKEND` | Vision backend: `torch` or `mlx` | `torch` |

Index storage: `~/.retrieval-skill/indexes/` (one `.db` file per index).

## How to add new adapters

retrieval-skill uses a modular adapter pattern for embedding models. Each adapter implements:

```javascript
{
  name: 'my-adapter',
  type: 'text' | 'vision',
  init: () => Promise<void>,
  embedQuery: (query) => Promise<Float32Array | Float32Array[]>,
  embedDocuments: (texts) => Promise<Float32Array[]>,     // text adapters
  embedImages: (paths) => Promise<Float32Array[][]>,       // vision adapters
  embeddingDim: () => number,
  modelId: () => string,
  dispose: () => Promise<void>,
}
```

1. Create a new file in `src/adapters/` (e.g., `my-adapter.mjs`)
2. Export a factory function that returns an adapter object
3. Register it with `registerAdapter()` from `src/adapters/adapter.mjs`
4. The adapter will be available via `getAdapter(name)` or `getAdaptersByType(type)`

See `src/adapters/text-adapter.mjs` and `src/adapters/vision-adapter.mjs` for reference implementations.

## Search scoring

**Text mode** — hybrid score per chunk:
```
hybrid = 0.6 * cosine(queryVec, chunkVec) + 0.4 * normalized_fts_score
final  = hybrid * (1 - recencyWeight + recencyWeight * recencyBoost)
```

**Vision mode** — ColBERT-style MaxSim per page:
```
score = Σ_i max_j cosine(query_token_i, page_token_j)
```

**Hybrid mode** — Reciprocal Rank Fusion across three lanes:
```
RRF(d) = Σ_lane 1/(60 + rank_in_lane(d))
```

**Recency boost:**
```
boost = 1 / (1 + ageDays / halfLifeDays)
```

## Development

```bash
git clone https://github.com/c-h-/retrieval-skill.git
cd retrieval-skill
npm install
npm test
```

## License

[MIT](LICENSE)
