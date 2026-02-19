import { openDb, getMeta } from './schema.mjs';
import { embedQuery, blobToEmbedding } from './embedder.mjs';
import { indexDbPath } from './index.mjs';
import { searchVisionIndex } from './search/maxsim.mjs';
import { createVisionAdapter } from './adapters/vision-adapter.mjs';
import { relative } from 'path';

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
 * Cosine similarity between two normalized Float32Arrays (= dot product).
 */
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Escape FTS5 query: wrap each term in double quotes to avoid syntax errors.
 */
function ftsQuery(query) {
  return query
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => `"${t.replace(/"/g, '""')}"`)
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
 * Search a single index database (text pipeline only).
 * Returns array of results sorted by hybrid score.
 * This is the ORIGINAL text search — unchanged behavior when mode='text'.
 */
function searchIndex(db, queryEmbedding, query, topK, indexName, sourceDir, opts = {}) {
  // Step 1: FTS5 keyword search for candidate IDs
  const ftsQueryStr = ftsQuery(query);
  let ftsRows = [];
  try {
    ftsRows = db.prepare(
      'SELECT rowid, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 200'
    ).all(ftsQueryStr);
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

  // Step 2: Get all chunks for vector scoring
  // For small-to-medium indexes (<100K chunks), full scan is fast enough
  const allChunks = db.prepare(
    'SELECT c.id, c.file_id, c.chunk_index, c.content, c.embedding, c.section_context, c.content_timestamp_ms, f.path, f.metadata FROM chunks c JOIN files f ON c.file_id = f.id'
  ).all();

  // Step 3: Score all chunks
  const scored = [];
  for (const row of allChunks) {
    const vec = blobToEmbedding(row.embedding);
    const vecScore = cosine(queryEmbedding, vec);
    const ftsScore = ftsScores.get(row.id) || 0;
    const normalizedFts = maxFts > 0 ? ftsScore / maxFts : 0;

    // Hybrid: 60% vector + 40% FTS
    const hybrid = vecScore * 0.6 + normalizedFts * 0.4;

    // Apply recency boost: finalScore = semantic * (1 - w + w * boost)
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

  // Sort by hybrid score descending
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
 */
export async function search(query, indexNames, opts = {}) {
  const topK = opts.topK || 10;
  const threshold = opts.threshold || 0;
  const mode = opts.mode || 'text';
  const recencyWeight = opts.recencyWeight ?? 0.15;
  const halfLifeDays = opts.halfLifeDays ?? 90;

  // --- Text lane ---
  let textResults = [];
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
      const results = searchIndex(db, queryEmbedding, query, topK * 2, name, sourceDir, { recencyWeight, halfLifeDays });
      textResults.push(...results);
      db.close();
    }
  }

  // --- Vision lane ---
  let visionResults = [];
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
    return visionResults.slice(0, topK).filter(r => r.score >= threshold);
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
    const key = r.filePath + ':' + r.chunkIndex;
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
  const vecList = textByVec.map((r, i) => {
    const id = `text:${r.filePath}:${r.chunkIndex}`;
    allItems.set(id, r);
    return { id };
  });

  // Lane 2: Text results sorted by FTS score
  const textByFts = [...textResults].sort((a, b) => b.ftsScore - a.ftsScore);
  const ftsList = textByFts.map((r, i) => {
    const id = `text:${r.filePath}:${r.chunkIndex}`;
    allItems.set(id, r);
    return { id };
  });

  // Lane 3: Vision results sorted by MaxSim score
  const visionSorted = [...visionResults].sort((a, b) => b.score - a.score);
  const visionList = visionSorted.map((r, i) => {
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
  return fused.slice(0, topK).filter(r => r.rrfScore >= threshold);
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
  return JSON.stringify(results.map(r => ({
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
  })), null, 2);
}
