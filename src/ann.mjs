/**
 * Approximate Nearest Neighbor (ANN) indexing using IVF-Flat.
 *
 * Clusters chunk embeddings into sqrt(N) centroids using k-means.
 * At search time, probes the top `nprobe` nearest centroids and only
 * scores chunks within those clusters — avoiding a full scan.
 *
 * Schema additions (v5):
 *   - ann_centroids table: stores cluster centroid vectors
 *   - cluster_id column on chunks: assigned cluster ID
 */

import { blobToEmbedding, embeddingToBlob } from './embedder.mjs';

/**
 * Run k-means clustering on a set of vectors.
 *
 * @param {Float32Array[]} vectors - Input vectors
 * @param {number} k - Number of clusters
 * @param {number} maxIter - Maximum iterations
 * @returns {Float32Array[]} k centroid vectors
 */
export function kmeans(vectors, k, maxIter = 20) {
  const dim = vectors[0].length;
  const n = vectors.length;

  // Initialize centroids using k-means++ seeding
  const centroids = kmeansInit(vectors, k);

  const assignments = new Int32Array(n);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign each vector to the nearest centroid
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const nearest = nearestCentroid(vectors[i], centroids);
      if (nearest !== assignments[i]) {
        assignments[i] = nearest;
        changed++;
      }
    }

    // Recompute centroids
    const sums = centroids.map(() => new Float64Array(dim));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      const v = vectors[i];
      const s = sums[c];
      for (let d = 0; d < dim; d++) s[d] += v[d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      const centroid = new Float32Array(dim);
      const s = sums[c];
      for (let d = 0; d < dim; d++) centroid[d] = s[d] / counts[c];
      centroids[c] = centroid;
    }

    // Converged if less than 0.1% of points changed
    if (changed < n * 0.001) break;
  }

  return centroids;
}

/**
 * K-means++ initialization: pick diverse initial centroids.
 */
function kmeansInit(vectors, k) {
  const n = vectors.length;
  const centroids = [];

  // First centroid: random
  centroids.push(vectors[Math.floor(Math.random() * n)]);

  const dists = new Float64Array(n).fill(Infinity);

  for (let c = 1; c < k; c++) {
    // Update distances to nearest centroid
    const last = centroids[c - 1];
    for (let i = 0; i < n; i++) {
      const d = squaredDist(vectors[i], last);
      if (d < dists[i]) dists[i] = d;
    }

    // Pick next centroid with probability proportional to distance²
    let total = 0;
    for (let i = 0; i < n; i++) total += dists[i];
    let target = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      target -= dists[i];
      if (target <= 0) { chosen = i; break; }
    }
    centroids.push(vectors[chosen]);
  }

  return centroids;
}

function squaredDist(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Find the nearest centroid index for a vector.
 */
function nearestCentroid(vec, centroids) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const d = squaredDist(vec, centroids[i]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Build an IVF-Flat ANN index for all chunks in the database.
 * Clusters embeddings and stores centroid vectors + cluster assignments.
 *
 * @param {Object} db - SQLite database instance
 * @param {Object} opts
 * @param {number} opts.minChunks - Minimum chunks to build ANN (default 1000)
 */
export function buildAnnIndex(db, opts = {}) {
  const minChunks = opts.minChunks ?? 1000;

  // Load all chunk embeddings
  const rows = db.prepare('SELECT id, embedding FROM chunks').all();
  if (rows.length < minChunks) {
    return { built: false, reason: `Only ${rows.length} chunks (need ${minChunks})`, numClusters: 0 };
  }

  const vectors = rows.map(r => blobToEmbedding(r.embedding));
  const ids = rows.map(r => r.id);

  // Number of clusters: sqrt(N), clamped to [8, 4096]
  const k = Math.max(8, Math.min(4096, Math.round(Math.sqrt(rows.length))));

  console.error(`[ann] Building IVF-Flat index: ${rows.length} vectors → ${k} clusters...`);
  const centroids = kmeans(vectors, k);

  // Create ANN tables if needed
  db.exec(`
    CREATE TABLE IF NOT EXISTS ann_centroids (
      id INTEGER PRIMARY KEY,
      centroid BLOB NOT NULL
    )
  `);

  // Ensure cluster_id column exists on chunks
  const cols = db.pragma('table_info(chunks)').map(c => c.name);
  if (!cols.includes('cluster_id')) {
    db.exec('ALTER TABLE chunks ADD COLUMN cluster_id INTEGER');
  }

  // Store centroids and assign clusters in a single transaction
  db.transaction(() => {
    // Clear old centroids
    db.exec('DELETE FROM ann_centroids');

    const insertCentroid = db.prepare('INSERT INTO ann_centroids (id, centroid) VALUES (?, ?)');
    for (let i = 0; i < centroids.length; i++) {
      insertCentroid.run(i, embeddingToBlob(centroids[i]));
    }

    // Assign each chunk to its nearest centroid
    const updateCluster = db.prepare('UPDATE chunks SET cluster_id = ? WHERE id = ?');
    for (let i = 0; i < vectors.length; i++) {
      const clusterId = nearestCentroid(vectors[i], centroids);
      updateCluster.run(clusterId, ids[i]);
    }
  })();

  // Create index for fast cluster lookups
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_cluster ON chunks(cluster_id)');

  console.error(`[ann] Done. ${k} centroids, ${rows.length} chunks assigned.`);
  return { built: true, numClusters: k, numChunks: rows.length };
}

/**
 * Check whether the database has a built ANN index.
 */
export function hasAnnIndex(db) {
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM ann_centroids').get();
    return row.cnt > 0;
  } catch {
    return false;
  }
}

/**
 * Get candidate chunk IDs using the ANN index.
 * Probes the top `nprobe` nearest centroids and returns all chunk IDs in those clusters.
 *
 * @param {Object} db - SQLite database instance
 * @param {Float32Array} queryEmbedding - Query vector
 * @param {number} nprobe - Number of centroids to probe (default 10)
 * @returns {Set<number>} Set of candidate chunk IDs
 */
export function annCandidates(db, queryEmbedding, nprobe = 10) {
  // Load centroids
  const centroidRows = db.prepare('SELECT id, centroid FROM ann_centroids ORDER BY id').all();
  const centroids = centroidRows.map(r => ({
    id: r.id,
    vec: blobToEmbedding(r.centroid),
  }));

  // Find top nprobe nearest centroids using dot product (cosine for normalized vecs)
  const scored = centroids.map(c => ({
    id: c.id,
    score: dot(queryEmbedding, c.vec),
  }));
  scored.sort((a, b) => b.score - a.score);
  const probeIds = scored.slice(0, nprobe).map(s => s.id);

  // Get all chunk IDs in these clusters
  const placeholders = probeIds.map(() => '?').join(',');
  const chunkRows = db.prepare(
    `SELECT id FROM chunks WHERE cluster_id IN (${placeholders})`
  ).all(...probeIds);

  return new Set(chunkRows.map(r => r.id));
}
