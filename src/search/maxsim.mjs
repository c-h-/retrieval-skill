/**
 * MaxSim scoring for ColBERT-style multi-vector search.
 *
 * ColBERT late interaction: for each query token vector, find the maximum
 * cosine similarity to any page patch vector. Sum these maxima.
 *
 * score(query, page) = sum over query tokens q_i of max_j(sim(q_i, p_j))
 *
 * For our corpus size (hundreds to low thousands of pages), brute-force is fine.
 */

/**
 * Dot product of two Float32Arrays (used as cosine sim for normalized vectors).
 */
function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * L2 norm of a Float32Array.
 */
function norm(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/**
 * Cosine similarity between two Float32Arrays.
 */
function cosineSim(a, b) {
  const d = dot(a, b);
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return d / (na * nb);
}

/**
 * Compute MaxSim score between a query (multi-vector) and a page (multi-vector).
 *
 * @param {Float32Array[]} queryVectors - Array of query token vectors
 * @param {Float32Array[]} pageVectors - Array of page patch vectors
 * @returns {number} MaxSim score (sum of per-query-token max similarities)
 */
export function maxSimScore(queryVectors, pageVectors) {
  let totalScore = 0;
  for (const qVec of queryVectors) {
    let maxSim = -Infinity;
    for (const pVec of pageVectors) {
      const sim = cosineSim(qVec, pVec);
      if (sim > maxSim) maxSim = sim;
    }
    totalScore += maxSim;
  }
  return totalScore;
}

/**
 * Search all pages in the vision index using MaxSim scoring.
 *
 * @param {Object} db - SQLite database instance
 * @param {Float32Array[]} queryVectors - Embedded query (multi-vector)
 * @param {number} topK - Number of results to return
 * @returns {Array<{pageImageId, documentId, pageNumber, score, sourcePath}>}
 */
export function searchVisionIndex(db, queryVectors, topK = 10) {
  // Get all page images
  const pages = db.prepare('SELECT id, document_id, page_number, source_path FROM page_images').all();

  if (pages.length === 0) return [];

  const scored = [];

  for (const page of pages) {
    // Load all vectors for this page
    const vectorRows = db.prepare(
      'SELECT embedding FROM page_vectors WHERE page_image_id = ? ORDER BY vector_index'
    ).all(page.id);

    const pageVectors = vectorRows.map(row => {
      const buf = row.embedding;
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    });

    if (pageVectors.length === 0) continue;

    const score = maxSimScore(queryVectors, pageVectors);

    scored.push({
      pageImageId: page.id,
      documentId: page.document_id,
      pageNumber: page.page_number,
      score,
      sourcePath: page.source_path,
    });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}
