import { relative } from 'path';
import { createVisionAdapter } from './adapters/vision-adapter.mjs';
import { vecSearch } from './ann.mjs';
import { embedQuery } from './embedder.mjs';
import { indexDbPath } from './index.mjs';
import { getMeta, openDb } from './schema.mjs';
import { searchVisionIndex } from './search/maxsim.mjs';

/**
 * Compute a recency multiplier for a content timestamp.
 * Returns a value in (0, 1] — recent content scores higher.
 * Null timestamp → 1.0 (no boost or penalty).
 *
 * @param {number|null} contentTimestampMs
 * @param {number} halfLifeDays
 * @returns {number}
 */
export function recencyBoost(contentTimestampMs, halfLifeDays = 90) {
  if (contentTimestampMs == null) return 1.0;
  const ageDays = (Date.now() - contentTimestampMs) / 86_400_000;
  if (ageDays <= 0) return 1.0;
  return 1 / (1 + ageDays / halfLifeDays);
}

/**
 * Format a relative age string from a timestamp.
 * Returns e.g. "2d ago", "3mo ago", "1y ago", or null.
 */
export function relativeAge(timestampMs) {
  if (timestampMs == null) return null;
  const diffMs = Date.now() - timestampMs;
  if (diffMs < 0) return 'just now';
  const days = Math.floor(diffMs / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

/**
 * Convert sqlite-vec L2 distance to a cosine-like score in [0, 1].
 * For normalized vectors, L2² = 2(1 - cos). So cos = 1 - dist²/2.
 */
function distanceToScore(distance) {
  return Math.max(0, 1 - (distance * distance) / 2);
}

/**
 * Escape FTS5 query: wrap each term in double quotes to avoid syntax errors.
 */
function ftsQuery(query) {
  return query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/**
 * Reciprocal Rank Fusion: merge multiple ranked lists.
 * Each list is an array of items with an `id` property.
 * Returns a Map of id → RRF score.
 *
 * RRF(d) = sum over lists r of 1/(k + rank_r(d))
 * where k=60 is the standard constant.
 */
function rrfFuse(rankedLists, k = 60) {
  const scores = new Map();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const prev = scores.get(item.id) || 0;
      scores.set(item.id, prev + 1 / (k + rank + 1));
    }
  }
  return scores;
}

/**
 * Check if a metadata JSON object matches all filter conditions.
 * Each filter key must exist in the metadata and match the filter value.
 * Filter values are compared as strings (case-insensitive).
 *
 * @param {string|null} metadataJson - JSON string from the files table
 * @param {Object} filters - key-value pairs to match
 * @returns {boolean}
 */
export function matchesFilters(metadataJson, filters) {
  if (!filters || Object.keys(filters).length === 0) return true;
  if (!metadataJson) return false;
  let meta;
  try {
    meta = JSON.parse(metadataJson);
  } catch {
    return false;
  }
  for (const [key, value] of Object.entries(filters)) {
    const metaVal = meta[key];
    if (metaVal == null) return false;
    if (String(metaVal).toLowerCase() !== String(value).toLowerCase()) return false;
  }
  return true;
}

/**
 * Search a single index database (text pipeline only).
 * Uses sqlite-vec for vector search, FTS5 for keyword search, then fuses.
 */
function searchIndex(db, queryEmbedding, query, topK, indexName, sourceDir, opts = {}) {
  const filters = opts.filters || null;

  // Step 1: FTS5 keyword search for candidate IDs
  const ftsQueryStr = ftsQuery(query);
  let ftsRows = [];
  try {
    ftsRows = db
      .prepare('SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 200')
      .all(ftsQueryStr);
  } catch {
    // FTS query may fail on unusual characters; fall back to pure vector
  }

  const ftsScores = new Map();
  let maxFts = 0;
  for (const row of ftsRows) {
    const score = -row.rank; // FTS5 rank is negative (lower = better)
    ftsScores.set(row.rowid, score);
    if (score > maxFts) maxFts = score;
  }

  // Step 2: sqlite-vec KNN search — returns top candidates by L2 distance
  const vecResults = vecSearch(db, queryEmbedding, topK * 10);
  const vecScoreMap = new Map();
  for (const vr of vecResults) {
    vecScoreMap.set(vr.rowid, distanceToScore(vr.distance));
  }

  // Also include FTS-only candidates in the scoring set
  for (const rowid of ftsScores.keys()) {
    if (!vecScoreMap.has(rowid)) vecScoreMap.set(rowid, 0);
  }

  // Step 3: Fetch chunk details for all candidates
  const candidateIds = [...vecScoreMap.keys()];
  if (candidateIds.length === 0) return [];

  const placeholders = candidateIds.map(() => '?').join(',');
  const chunkRows = db
    .prepare(
      `SELECT c.id, c.file_id, c.chunk_index, c.content, c.section_context, c.content_timestamp_ms, f.path, f.metadata
       FROM chunks c JOIN files f ON c.file_id = f.id
       WHERE c.id IN (${placeholders})`,
    )
    .all(...candidateIds);

  // Step 4: Score and rank
  const scored = [];
  for (const row of chunkRows) {
    if (!matchesFilters(row.metadata, filters)) continue;

    const vecScore = vecScoreMap.get(row.id) || 0;
    const ftsScore = ftsScores.get(row.id) || 0;
    const normalizedFts = maxFts > 0 ? ftsScore / maxFts : 0;

    // Hybrid: 60% vector + 40% FTS
    const hybrid = vecScore * 0.6 + normalizedFts * 0.4;

    // Apply recency boost
    const recencyWeight = opts.recencyWeight ?? 0;
    const halfLifeDays = opts.halfLifeDays ?? 90;
    const boost = recencyBoost(row.content_timestamp_ms, halfLifeDays);
    const finalScore = hybrid * (1 - recencyWeight + recencyWeight * boost);

    scored.push({
      content: row.content,
      score: finalScore,
      semanticScore: hybrid,
      vecScore,
      ftsScore: normalizedFts,
      filePath: row.path,
      relativePath: sourceDir ? relative(sourceDir, row.path) : row.path,
      sectionContext: row.section_context,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      indexName,
      chunkIndex: row.chunk_index,
      contentTimestampMs: row.content_timestamp_ms,
      resultType: 'text',
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Search across one or more indexes.
 * indexNames: array of index names (e.g., ['linear', 'slack'])
 *
 * @param {string} query
 * @param {string[]} indexNames
 * @param {Object} opts
 * @param {number} opts.topK - default 10
 * @param {number} opts.threshold - default 0
 * @param {string} opts.mode - 'text' (default) | 'vision' | 'hybrid'
 * @param {Object} opts.filters - metadata key-value filters (e.g. { source: 'slack', status: 'open' })
 */
export async function search(query, indexNames, opts = {}) {
  const topK = opts.topK || 10;
  const threshold = opts.threshold || 0;
  const mode = opts.mode || 'text';
  const recencyWeight = opts.recencyWeight ?? 0.15;
  const halfLifeDays = opts.halfLifeDays ?? 90;
  const filters = opts.filters || null;

  // --- Text lane ---
  const textResults = [];
  if (mode === 'text' || mode === 'hybrid') {
    const queryEmbedding = await embedQuery(query);

    for (const name of indexNames) {
      const dbPath = indexDbPath(name);
      let db;
      try {
        db = openDb(dbPath);
      } catch (err) {
        console.error(`Warning: Could not open index "${name}": ${err.message}`);
        continue;
      }

      const sourceDir = getMeta(db, 'source_directory');
      const results = searchIndex(db, queryEmbedding, query, topK * 2, name, sourceDir, {
        recencyWeight,
        halfLifeDays,
        filters,
      });
      textResults.push(...results);
      db.close();
    }
  }

  // --- Vision lane ---
  const visionResults = [];
  if (mode === 'vision' || mode === 'hybrid') {
    let visionAdapter = null;
    try {
      visionAdapter = createVisionAdapter();
      await visionAdapter.init();

      const queryVectors = await visionAdapter.embedQuery(query);

      for (const name of indexNames) {
        const dbPath = indexDbPath(name);
        let db;
        try {
          db = openDb(dbPath, { vision: true });
        } catch (err) {
          console.error(`Warning: Could not open index "${name}" for vision: ${err.message}`);
          continue;
        }

        // Check if this index has vision data
        const hasVision = getMeta(db, 'vision_adapter');
        if (!hasVision) {
          db.close();
          continue;
        }

        const maxSimResults = searchVisionIndex(db, queryVectors, topK * 2);
        const sourcePath = getMeta(db, 'source_path');

        for (const r of maxSimResults) {
          visionResults.push({
            content: `[Page ${r.pageNumber + 1}]`,
            score: r.score,
            vecScore: r.score,
            ftsScore: 0,
            filePath: sourcePath || r.sourcePath,
            relativePath: `page_${r.pageNumber + 1}`,
            sectionContext: `Page ${r.pageNumber + 1}`,
            metadata: null,
            indexName: name,
            pageNumber: r.pageNumber,
            resultType: 'vision',
            sourcePath: r.sourcePath,
          });
        }

        db.close();
      }

      await visionAdapter.dispose();
    } catch (err) {
      console.error(`Warning: Vision search failed: ${err.message}`);
      if (visionAdapter) await visionAdapter.dispose().catch(() => {});
    }
  }

  // --- Fusion ---
  if (mode === 'text') {
    // Original behavior: merge by score, dedup, threshold
    return _mergeTextResults(textResults, topK, threshold);
  }

  if (mode === 'vision') {
    // Vision-only: sort by MaxSim score
    visionResults.sort((a, b) => b.score - a.score);
    return visionResults.slice(0, topK).filter((r) => r.score >= threshold);
  }

  // Hybrid mode: RRF fusion across text vector, text FTS, and vision lanes
  return _hybridRrfFuse(textResults, visionResults, topK, threshold);
}

/**
 * Original text-only merge (unchanged behavior).
 */
function _mergeTextResults(allResults, topK, threshold) {
  const seen = new Set();
  const deduped = [];
  allResults.sort((a, b) => b.score - a.score);
  for (const r of allResults) {
    const key = `${r.filePath}:${r.chunkIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.score >= threshold) {
      deduped.push(r);
    }
  }
  return deduped.slice(0, topK);
}

/**
 * Hybrid RRF fusion across three lanes:
 * 1. Text vector ranked list (sorted by vecScore)
 * 2. Text FTS ranked list (sorted by ftsScore)
 * 3. Vision MaxSim ranked list (sorted by score)
 *
 * Each item gets an RRF score, then we sort and return top-K.
 */
function _hybridRrfFuse(textResults, visionResults, topK, threshold) {
  // Build unique IDs for all results
  const allItems = new Map(); // id → result object

  // Lane 1: Text results sorted by vector score
  const textByVec = [...textResults].sort((a, b) => b.vecScore - a.vecScore);
  const vecList = textByVec.map((r, _i) => {
    const id = `text:${r.filePath}:${r.chunkIndex}`;
    allItems.set(id, r);
    return { id };
  });

  // Lane 2: Text results sorted by FTS score
  const textByFts = [...textResults].sort((a, b) => b.ftsScore - a.ftsScore);
  const ftsList = textByFts.map((r, _i) => {
    const id = `text:${r.filePath}:${r.chunkIndex}`;
    allItems.set(id, r);
    return { id };
  });

  // Lane 3: Vision results sorted by MaxSim score
  const visionSorted = [...visionResults].sort((a, b) => b.score - a.score);
  const visionList = visionSorted.map((r, _i) => {
    const id = `vision:${r.indexName}:${r.pageNumber}`;
    allItems.set(id, r);
    return { id };
  });

  // RRF fusion
  const rrfScores = rrfFuse([vecList, ftsList, visionList]);

  // Build final results
  const fused = [];
  for (const [id, rrfScore] of rrfScores) {
    const item = allItems.get(id);
    if (!item) continue;
    fused.push({
      ...item,
      rrfScore,
      score: rrfScore, // Override score with RRF for ranking
    });
  }

  fused.sort((a, b) => b.rrfScore - a.rrfScore);
  return fused.slice(0, topK).filter((r) => r.rrfScore >= threshold);
}

/**
 * Format results for human-readable output.
 */
export function formatResults(results, query) {
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const lines = [`Results for "${query}":\n`];
  for (const r of results) {
    const displayPath = r.relativePath || r.filePath;
    const ctx = r.sectionContext ? ` § ${r.sectionContext}` : '';
    const typeTag = r.resultType === 'vision' ? ' [vision]' : '';
    const age = relativeAge(r.contentTimestampMs);
    const scorePart = age ? `${r.score.toFixed(2)} | ${age}` : r.score.toFixed(3);
    lines.push(`[${scorePart}] ${r.indexName}/${displayPath}${ctx}${typeTag}`);

    // Show snippet (first 200 chars)
    const snippet = (r.content || '').replace(/\n/g, ' ').slice(0, 200);
    lines.push(`  "${snippet}${(r.content || '').length > 200 ? '...' : ''}"\n`);
  }
  return lines.join('\n');
}

/**
 * Format results as JSON.
 */
export function formatResultsJson(results) {
  return JSON.stringify(
    results.map((r) => ({
      score: r.score,
      semanticScore: r.semanticScore,
      rrfScore: r.rrfScore,
      vecScore: r.vecScore,
      ftsScore: r.ftsScore,
      indexName: r.indexName,
      filePath: r.filePath,
      relativePath: r.relativePath,
      sectionContext: r.sectionContext,
      content: r.content,
      metadata: r.metadata,
      contentTimestampMs: r.contentTimestampMs,
      resultType: r.resultType || 'text',
      pageNumber: r.pageNumber,
      sourcePath: r.sourcePath,
    })),
    null,
    2,
  );
}
