---
name: retrieval
description: >
  Search organizational knowledge across Slack, Notion, Linear, Gmail and local documents.
  Use when: "find", "search", "look up", "what do we know about", "summarize everything about",
  "deep research", "investigate", "who said", "when did", "any docs about", "check our knowledge base".
  Capabilities: fast hybrid vector+keyword search, deep cross-source research with provenance,
  SaaS mirroring, incremental indexing, metadata filtering, recency-aware ranking.
metadata:
  author: Charlie Hulcher
  version: 1.0.0
  openclaw:
    requires:
      anyBins: ["node"]
---

# Retrieval Skill

Organizational knowledge system: mirror SaaS data, index it, search it, deep research it.

## Setup

The CLI is at `{{SKILL_DIR}}/src/cli.mjs`. All commands below use this path.

### Prerequisites

1. **Node.js >= 18** and an **embedding server** (Octen-8B compatible, OpenAI API format):
   ```bash
   # Verify
   node --version
   curl -s http://localhost:8100/v1/embeddings -d '{"input":"test","model":"Octen/Octen-Embedding-8B"}' | head -c 100
   ```

2. **Install dependencies** (one-time):
   ```bash
   cd {{SKILL_DIR}} && npm install
   ```

3. **Configure connectors** (optional, for SaaS mirroring):
   ```bash
   cp {{SKILL_DIR}}/.env.example {{SKILL_DIR}}/.env
   # Edit .env with your API credentials. Each connector activates when its credentials are present.
   ```

### Connector Credentials

| Connector | Required Env Vars | How to Get |
|-----------|------------------|------------|
| Slack | `SLACK_BOT_TOKEN` | Slack App > OAuth & Permissions > Bot Token |
| Notion | `NOTION_TOKEN` | Notion Settings > Integrations > Internal Integration |
| Linear | `LINEAR_API_KEY` | Linear Settings > API > Personal API Key |
| Gmail | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Google Cloud Console > OAuth 2.0 Credentials |

## Quick Retrieval (Fast Lookup)

Use this mode for direct questions that need a fast answer from indexed sources.

### Step 1: Discover available indexes

```bash
node {{SKILL_DIR}}/src/cli.mjs list
```

This returns all indexes with their names, source directories, file/chunk counts, and last-indexed timestamps.

### Step 2: Search

```bash
# Search a single index
node {{SKILL_DIR}}/src/cli.mjs search "your query" --index INDEX_NAME --json

# Search multiple indexes at once
node {{SKILL_DIR}}/src/cli.mjs search "your query" --index idx1,idx2,idx3 --json

# With metadata filtering
node {{SKILL_DIR}}/src/cli.mjs search "your query" --index INDEX_NAME --json --filter source=slack --filter type=message

# Increase result count
node {{SKILL_DIR}}/src/cli.mjs search "your query" --index INDEX_NAME --json --top-k 20
```

**Always use `--json`** for structured output. Each result includes:
- `filePath`: source document path
- `content`: matching chunk text
- `score`: relevance score (0-1)
- `metadata`: frontmatter fields (source, type, date, etc.)

### Search Options

| Flag | Default | Description |
|------|---------|-------------|
| `--index <names>` | required | Comma-separated index names |
| `--top-k <n>` | 10 | Number of results |
| `--threshold <score>` | 0 | Minimum score cutoff |
| `--mode <mode>` | text | `text`, `vision`, or `hybrid` |
| `--recency-weight <n>` | 0.15 | Recency boost (0 to disable) |
| `--half-life <days>` | 90 | Recency half-life in days |
| `--filter <key=value>` | none | Metadata filter (repeatable) |
| `--json` | false | JSON output |

## Deep Retrieval (Exhaustive Research)

Use this mode when the user wants a thorough investigation across all knowledge sources. This is an investigative loop, not a single query.

### The Deep Retrieval Loop

1. **Discover all indexes**: Run `node {{SKILL_DIR}}/src/cli.mjs list` to see everything available.

2. **Broad initial search**: Search ALL relevant indexes with the user's question. Use low threshold, high top-k:
   ```bash
   node {{SKILL_DIR}}/src/cli.mjs search "initial question" --index ALL_INDEXES --json --top-k 20 --threshold 0
   ```

3. **Find leads**: Read the top results. Identify names, terms, dates, and threads worth following.

4. **Explore directly**: Read the source files referenced in results to get full context:
   ```bash
   cat /path/to/source/document.md
   ```

5. **Develop new questions**: Based on what you found, formulate follow-up queries. Search for:
   - Names or identifiers mentioned in results
   - Related concepts or synonyms
   - Time-adjacent events
   - Cross-source corroboration (e.g., find Slack discussion about a Linear issue)

6. **Search again with refined queries**: Each iteration should be more targeted:
   ```bash
   node {{SKILL_DIR}}/src/cli.mjs search "specific follow-up" --index RELEVANT_INDEX --json --top-k 10
   ```

7. **Repeat steps 3-6** until you've exhausted leads or have sufficient coverage.

8. **Synthesize**: Produce a report with:
   - Key findings organized by theme
   - Direct quotes with source attribution (file path, date, author)
   - Confidence levels for each finding
   - Gaps in knowledge (what you searched for but couldn't find)

### Deep Retrieval Tips

- **Cast a wide net first**: Start with all indexes, then narrow down.
- **Use metadata filters**: Filter by `source=slack`, `type=issue`, etc. to focus searches.
- **Cross-reference sources**: A Slack conversation about a Linear issue? Search both.
- **Follow the timeline**: Use recency options to find what happened when.
- **Read full documents**: Search results are chunks; read the full file for context.

## Indexing

### Index local markdown files

```bash
# Index a directory (incremental — only re-processes changed files)
node {{SKILL_DIR}}/src/cli.mjs index /path/to/markdown/dir --name my-index

# Index mirrored SaaS data after a sync
node {{SKILL_DIR}}/src/cli.mjs index ./data/slack --name slack
node {{SKILL_DIR}}/src/cli.mjs index ./data/notion --name notion
node {{SKILL_DIR}}/src/cli.mjs index ./data/linear --name linear
node {{SKILL_DIR}}/src/cli.mjs index ./data/gmail --name gmail
```

### Index a PDF with vision embeddings

```bash
node {{SKILL_DIR}}/src/cli.mjs index-vision /path/to/document.pdf --name my-pdf
```

### Manage indexes

```bash
# List all indexes
node {{SKILL_DIR}}/src/cli.mjs list

# Get detailed status
node {{SKILL_DIR}}/src/cli.mjs status INDEX_NAME

# Delete an index
node {{SKILL_DIR}}/src/cli.mjs delete INDEX_NAME
```

## Mirroring SaaS Data

Mirror replicates data from SaaS services into local Markdown files for indexing.

### Sync commands

```bash
# Incremental sync (all configured connectors)
node {{SKILL_DIR}}/src/cli.mjs mirror sync

# Full hydration (re-fetch everything)
node {{SKILL_DIR}}/src/cli.mjs mirror sync --full

# Sync a specific connector
node {{SKILL_DIR}}/src/cli.mjs mirror sync --adapter slack

# Custom output directory
node {{SKILL_DIR}}/src/cli.mjs mirror sync --output /path/to/data

# Check sync status
node {{SKILL_DIR}}/src/cli.mjs mirror status

# List configured connectors
node {{SKILL_DIR}}/src/cli.mjs mirror adapters

# Run as daemon (periodic sync)
node {{SKILL_DIR}}/src/cli.mjs mirror daemon --interval 15
```

### Typical workflow: Mirror then Index

```bash
# 1. Sync SaaS data
node {{SKILL_DIR}}/src/cli.mjs mirror sync

# 2. Index the mirrored data
node {{SKILL_DIR}}/src/cli.mjs index ./data/slack --name slack
node {{SKILL_DIR}}/src/cli.mjs index ./data/notion --name notion
node {{SKILL_DIR}}/src/cli.mjs index ./data/linear --name linear
node {{SKILL_DIR}}/src/cli.mjs index ./data/gmail --name gmail

# 3. Search across everything
node {{SKILL_DIR}}/src/cli.mjs search "query" --index slack,notion,linear,gmail --json
```

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `ECONNREFUSED` on search/index | Embedding server not running | Start the embedding server on port 8100 |
| `No indexes found` | No data indexed yet | Run `index` command on a directory first |
| `No adapters configured` | Missing env vars for mirror | Add API credentials to `.env` file |
| `SQLITE_ERROR` | Corrupted index | Delete and re-index: `node {{SKILL_DIR}}/src/cli.mjs delete NAME` |
| `rate limit` / `429` on mirror | API throttling | Connectors handle this automatically with backoff; retry if persistent |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_SERVER_URL` | `http://localhost:8100` | Embedding server endpoint |
| `VISION_BACKEND` | `torch` | Vision backend: `torch` or `mlx` |

See `.env.example` for the full list including connector credentials.
