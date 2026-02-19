# Recency Boost for Retrieval Search

## Goal
Add time-aware scoring to search results so recent content is preferred over stale content, with semantic relevance still dominant.

## Current State
- `files` table has `mtime_ms` and `metadata` (JSON) columns
- `metadata` already contains timestamps from sources:
  - **Notion**: `created_time`, `last_edited_time` (ISO strings)
  - **Linear**: `createdAt`, `updatedAt` (ISO strings)
  - **Slack**: `exported_at` per channel (not per-message — gap, but usable)
  - **Mono**: `last-reviewed` (date string), plus filesystem `mtime_ms`
- `chunks` table has no timestamp column
- Search scoring is pure semantic (vector + FTS hybrid with RRF fusion)

## Changes Required

### 1. Schema Migration (schema.mjs)
- Bump `SCHEMA_VERSION` to 4
- Add `content_timestamp_ms INTEGER` column to `chunks` table (nullable)
- Migration: `ALTER TABLE chunks ADD COLUMN content_timestamp_ms INTEGER` for existing DBs
- Backward compatible: null = no recency boost applied to that chunk

### 2. Timestamp Extraction (chunker.mjs)
Add `extractContentTimestamp(frontmatter, mtimeMs)` function:
- Priority order for frontmatter fields: `last_edited_time` > `updatedAt` > `updated_at` > `last_edited` > `createdAt` > `created_at` > `created_time` > `date` > `last-reviewed`
- Parse ISO strings and date strings to epoch ms
- Fall back to `mtimeMs` (file mtime) if no frontmatter date found
- Return `number | null`

### 3. Indexer (index.mjs)
- Call `extractContentTimestamp()` during indexing
- Pass the timestamp to chunk insertion
- All chunks from a file share the same `content_timestamp_ms` (file-level granularity is fine)

### 4. Search Scoring (search.mjs)
Add recency boost to final scoring:
```js
function recencyBoost(contentTimestampMs, halfLifeDays = 90) {
  if (!contentTimestampMs) return 1.0; // no timestamp = no boost/penalty
  const ageDays = (Date.now() - contentTimestampMs) / 86_400_000;
  return 1 / (1 + ageDays / halfLifeDays);
}

// Applied as:
finalScore = semanticScore * (1 - recencyWeight + recencyWeight * recencyBoost);
```

- Default `recencyWeight`: 0.15 (semantic still dominates)
- Default `halfLifeDays`: 90
- Both configurable via search options

### 5. CLI (cli.mjs)
- Add `--recency-weight <n>` option (default 0.15, 0 to disable)
- Add `--half-life <days>` option (default 90)
- Display timestamp in results when available: `[0.83 | 2d ago]` or `[0.83 | 3mo ago]`

### 6. Format Output
Update `formatResults()` to show relative age next to score when `content_timestamp_ms` is present.

## Non-Goals
- Per-message Slack timestamps (separate indexer enhancement)
- Re-indexing existing data (user runs `retrieval-skill index --reindex` manually)

## Implementation Status

All sections implemented in `feat/recency-boost` branch:

- **Schema (schema.mjs)**: `SCHEMA_VERSION` bumped to 4. `content_timestamp_ms INTEGER` added to `chunks` table. v3→v4 migration adds column to existing DBs via `ALTER TABLE`.
- **Timestamp extraction (chunker.mjs)**: `extractContentTimestamp(frontmatter, mtimeMs)` exported. Parses ISO strings, date strings, and numeric epoch values. Falls back to file mtime.
- **Indexer (index.mjs)**: Calls `extractContentTimestamp()` during indexing; all chunks from a file share the same `content_timestamp_ms`.
- **Search scoring (search.mjs)**: `recencyBoost()` and `relativeAge()` exported. Final score: `semanticScore * (1 - recencyWeight + recencyWeight * boost)`. Defaults: weight 0.15, half-life 90 days.
- **CLI (cli.mjs)**: `--recency-weight <n>` and `--half-life <days>` options added to `search` command.
- **Formatted output**: Shows `[0.83 | 2d ago]` when `content_timestamp_ms` is present.

## Testing
- `__tests__/recency.test.mjs`: 27 tests covering `extractContentTimestamp()`, `recencyBoost()`, and `relativeAge()`
- Unit tests for `extractContentTimestamp()` with various frontmatter shapes (Notion, Linear, Slack, Mono, snake_case, numeric epochs, invalid dates, priority ordering)
- Unit tests for `recencyBoost()` math (null=1.0, half-life precision, future timestamps, scoring formula)
- Unit tests for `relativeAge()` formatting (today, days, months, years)
