# retrieval-skill

Organizational knowledge system: mirror SaaS data, index it, search it, deep research it. Powers semantic search across Slack, Notion, Linear, Gmail, and local documents for [OpenClaw](https://github.com/orgloop) agents.

## What it does

retrieval-skill is the complete retrieval stack:

1. **Mirror** — replicate SaaS data (Slack, Notion, Linear, Gmail) into local Markdown
2. **Index** — incremental indexing of Markdown files and PDFs into SQLite databases
3. **Search** — hybrid search combining vector similarity, keyword matching, and recency
4. **Deep research** — exhaustive cross-source investigation with provenance

### Search capabilities

- **Vector similarity** (60%) — SIMD-accelerated nearest-neighbor search via [sqlite-vec](https://github.com/asg017/sqlite-vec) + [Octen-Embedding-8B](https://huggingface.co/Octen/Octen-Embedding-8B) (4096-dim)
- **FTS5 keyword matching** (40%) — SQLite full-text search with BM25 ranking
- **Vision embeddings** — [ColQwen2.5](https://huggingface.co/tsystems/colqwen2.5-3b-multilingual-v1.0-merged) multi-vector page embeddings for PDF retrieval
- **Recency boost** — time-aware scoring with configurable half-life decay
- **RRF fusion** — Reciprocal Rank Fusion across text, keyword, and vision search lanes

### Connector capabilities

- **Slack** — channels, threads, files, with per-channel incremental sync
- **Notion** — pages, databases, with recursive block tree rendering
- **Linear** — issues, comments, attachments, with per-team sync
- **Gmail** — messages, threads, labels, with history-based incremental sync

All connectors support incremental sync, crash-resumable state, per-entity error isolation, and automatic rate limiting.

## Getting Started from Zero

End-to-end setup: embedding server, retrieval stack, connectors, first search.

### 1. Set up the embedding server

```bash
git clone https://github.com/c-h-/octen-embeddings-server.git
cd octen-embeddings-server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Download pre-converted MLX weights (~16 GB)
huggingface-cli download chulcher/Octen-Embedding-8B-mlx --local-dir models/Octen-Embedding-8B-mlx
```

### 2. Set up retrieval-skill

```bash
git clone https://github.com/c-h-/retrieval-skill.git
cd retrieval-skill
npm install
npm link   # makes `retrieve` available globally
```

### 3. Configure connectors

```bash
cp .env.example .env
# Edit .env — add credentials for the connectors you want (Slack, Notion, Linear, Gmail)
# Only connectors with valid credentials will activate
```

### 4. Start the stack

```bash
retrieve up
# Starts the embedding server, waits for it to be healthy,
# loads the sync scheduler, then runs `retrieve doctor` to verify.
```

### 5. First sync and index

```bash
retrieve mirror sync           # Pull data from configured connectors
retrieve index ./data/slack --name slack
retrieve index ./data/notion --name notion
```

### 6. Search

```bash
retrieve search "authentication flow" --index slack,notion --json
```

### 7. Verify health

```bash
retrieve doctor
# Shows pass/fail for: embedding server, connectors, indexes, disk, scheduler
```

## Architecture

```
SaaS APIs (Slack, Notion, Linear, Gmail)
        │
        └─── Mirror Pipeline ─────────────────────────────┐
             API fetch → rate limiting → Markdown + YAML   │
             → local filesystem (data/{source}/)           │
                                                           │
Markdown/PDF Files ────────────────────────────────────────┘
        │
        ├─── Text Pipeline ──────────────────────────────┐
        │    walkFiles() → chunkDocument()                │
        │    → Octen-8B embeddings (4096-dim)             │
        │    → SQLite: files, chunks, chunks_fts          │
        │    → sqlite-vec: chunks_vec (SIMD KNN)          │
        │                                                 │
        ├─── Vision Pipeline ────────────────────────────┐│
        │    extractPages() (PDF → PNG)                  ││
        │    → ColQwen2.5 multi-vector (128-dim × ~700)  ││
        │    → SQLite: page_images, page_vectors         ││
        │                                                ││
        └─── Hybrid Search ──────────────────────────────┘│
             sqlite-vec KNN + FTS5 keyword matching       │
             + MaxSim vision scoring                      │
             → RRF fusion → recency boost → top-K         │
```

Each index is a self-contained SQLite database stored in `~/.retrieval-skill/indexes/`.

## Installation

```bash
git clone https://github.com/c-h-/retrieval-skill.git
cd retrieval-skill
npm install
npm link   # makes the `retrieve` command available globally
```

**Requirements:**
- Node.js >= 18.0.0
- An embedding server running at `http://localhost:8100` (OpenAI-compatible API, e.g. [Octen-Embedding-8B](https://huggingface.co/Octen/Octen-Embedding-8B) via MLX)

**For vision features (optional):**
- Python >= 3.10
- PyTorch + MPS backend, or Apple MLX

```bash
# PyTorch (default)
cd src/vision && bash setup.sh

# Or MLX (faster for queries on Apple Silicon)
cd src/vision && bash setup-mlx.sh
```

**For SaaS connectors (optional):**
```bash
cp .env.example .env
# Edit .env with your API credentials
```

## Quick start

### Mirror + Index + Search

```bash
# 1. Sync data from configured SaaS connectors
retrieve mirror sync

# 2. Index the mirrored data
retrieve index ./data/slack --name slack
retrieve index ./data/notion --name notion

# 3. Search across everything
retrieve search "authentication flow" --index slack,notion --json
```

### Index local files directly

```bash
# Index a directory of markdown files
retrieve index ./my-docs --name docs

# Index a PDF with vision embeddings
retrieve index-vision ./handbook.pdf --name handbook

# Hybrid search (text + vision)
retrieve search "onboarding process" --index docs,handbook --mode hybrid --json
```

## CLI reference

### Indexing

#### `retrieve index <directory>`

Index a directory of markdown files (`.md`, `.markdown`, `.txt`).

| Option | Description | Default |
|--------|-------------|---------|
| `--name <name>` | Index name | Directory basename |

#### `retrieve index-vision <pdf>`

Index a PDF using vision embeddings (ColQwen2.5 multi-vector).

| Option | Description | Default |
|--------|-------------|---------|
| `--name <name>` | Index name | PDF filename (without `.pdf`) |
| `--batch-size <n>` | Pages per embedding batch | `2` |
| `--extract-text` | Also extract text for FTS search | off |

### Searching

#### `retrieve search <query>`

Search across one or more indexes.

| Option | Description | Default |
|--------|-------------|---------|
| `--index <names>` | Comma-separated index names | **(required)** |
| `--top-k <n>` | Number of results | `10` |
| `--threshold <score>` | Minimum score threshold | `0` |
| `--mode <mode>` | `text`, `vision`, or `hybrid` | `text` |
| `--recency-weight <n>` | Recency weight (0 disables) | `0.15` |
| `--half-life <days>` | Recency half-life in days | `90` |
| `--filter <key=value>` | Metadata filter (repeatable) | none |
| `--json` | Output as JSON | off |

### Index management

#### `retrieve list`

List all available indexes with metadata.

#### `retrieve status <name>`

Show detailed status of an index.

#### `retrieve delete <name>`

Delete an index and its database file.

### Mirroring

#### `retrieve mirror sync`

Sync data from configured SaaS connectors.

| Option | Description | Default |
|--------|-------------|---------|
| `--full` | Run full hydration instead of incremental | off |
| `--adapter <name>` | Sync a specific connector only | all configured |
| `--output <dir>` | Output directory | `./data` |

#### `retrieve mirror status`

Check last sync timestamp for all connectors.

#### `retrieve mirror adapters`

List which connectors are configured based on environment variables.

#### `retrieve mirror daemon`

Run as a long-lived daemon with periodic sync.

| Option | Description | Default |
|--------|-------------|---------|
| `--interval <minutes>` | Minutes between sync cycles | `15` |
| `--output <dir>` | Output directory | `./data` |

### Stack management

#### `retrieve doctor`

Check the full retrieval stack health (embedding server, connectors, indexes, disk, scheduler).

#### `retrieve up`

Start the embedding server and sync scheduler, then verify with `retrieve doctor`.

#### `retrieve down`

Stop the sync scheduler and embedding server.

## Connector setup

Each connector activates automatically when its required environment variables are set. Only configure the connectors you need.

| Connector | Required Env Vars | How to Get |
|-----------|------------------|------------|
| Slack | `SLACK_BOT_TOKEN` | Slack App > OAuth & Permissions > Bot Token. Scopes: `channels:history`, `channels:read`, `users:read` |
| Notion | `NOTION_TOKEN` | Notion Settings > Integrations > Internal Integration. Share target pages with the integration. |
| Linear | `LINEAR_API_KEY` | Linear Settings > API > Personal API Key |
| Gmail | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Google Cloud Console > OAuth 2.0 Credentials |

See `.env.example` for the full list of optional configuration variables.

## Supported index sources

retrieval-skill is source-agnostic — it indexes any directory of markdown files. Timestamp extraction is built in for common formats:

| Source | Timestamp field | Format |
|--------|----------------|--------|
| Notion | `last_edited_time` | ISO 8601 |
| Linear | `updatedAt` | ISO 8601 |
| Slack | `ts` | Unix epoch (seconds) |
| Mono | `updated_at` | ISO 8601 |
| Generic | `date`, `created`, `timestamp` | ISO 8601 or Unix |

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `EMBEDDING_SERVER_URL` | Text embedding server URL | `http://localhost:8100` |
| `VISION_BACKEND` | Vision backend: `torch` or `mlx` | `torch` |

Index storage: `~/.retrieval-skill/indexes/` (one `.db` file per index).

## Stack management

#### `retrieve up`

Start the embedding server and sync scheduler. Waits up to 30s for the embedding server to become healthy, then runs `retrieve doctor` to verify the full stack.

#### `retrieve down`

Stop the sync scheduler and embedding server. Kills by launchd label or by port.

#### `retrieve doctor`

Check the full stack health: embedding server, connector credentials, index freshness, disk space, and scheduler status. Exit code 0 if all critical checks pass.

| Variable | Description | Default |
|----------|-------------|---------|
| `OCTEN_SERVER_DIR` | Path to octen-embeddings-server checkout | `~/personal/octen-embeddings-server` |
| `OCTEN_PLIST_LABEL` | Launchd label for the embedding server | `com.openclaw.octen-embeddings` |
| `RETRIEVAL_PLIST_LABEL` | Launchd label for the sync scheduler | `com.retrieval-skill.sync` |

## Scheduling

A launchd-based scheduler runs mirror sync + indexing every 30 minutes.

### What it does

Every 30 minutes, the scheduler:
1. Runs `retrieve mirror sync` to pull latest data from configured connectors
2. Checks if the embedding server is running on `:8100`
3. If available, re-indexes each adapter directory (`slack`, `notion`, `linear`, `gog`)

### Install

```bash
bash scheduling/setup.sh install
```

This creates a launchd plist at `~/Library/LaunchAgents/com.retrieval-skill.sync.plist` and loads it immediately. The job also runs at load time.

### Uninstall

```bash
bash scheduling/setup.sh uninstall
```

### Check status

```bash
launchctl list | grep retrieval-skill
# or
retrieve doctor   # shows scheduler status alongside other checks
```

### Logs

Scheduler output goes to `/tmp/retrieval-skill-sync.log`:

```bash
tail -f /tmp/retrieval-skill-sync.log
```

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
