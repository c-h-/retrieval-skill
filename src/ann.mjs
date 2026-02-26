/**
 * Vector search via sqlite-vec.
 *
 * Uses the vec0 virtual table (chunks_vec) for SIMD-accelerated
 * nearest-neighbor search, replacing the old JS k-means/IVF-Flat code.
 *
 * The chunks_vec table shares rowid with the chunks table (1:1 mapping).
 */

import { embeddingToBlob } from './embedder.mjs';

/**
 * Insert an embedding into the vec0 virtual table.
 * Call this after inserting a row into the chunks table.
 *
 * @param {Object} db - SQLite database instance (with sqlite-vec loaded)
 * @param {number} rowid - The chunk rowid (must match chunks.id)
 * @param {Float32Array|Buffer} embedding - The embedding vector (Float32Array or Buffer blob)
 */
export function insertVec(db, rowid, embedding) {
  const blob = embedding instanceof Float32Array ? embeddingToBlob(embedding) : embedding;
  db.prepare('INSERT INTO chunks_vec (rowid, embedding) VALUES (CAST(? AS INTEGER), ?)').run(rowid, blob);
}

/**
 * Delete an embedding from the vec0 virtual table.
 *
 * @param {Object} db - SQLite database instance
 * @param {number} rowid - The chunk rowid to delete
 */
export function deleteVec(db, rowid) {
  db.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(rowid);
}

/**
 * Delete all vec entries for chunks belonging to a file.
 *
 * @param {Object} db - SQLite database instance
 * @param {number} fileId - The file ID whose chunk vecs should be removed
 */
export function deleteVecForFile(db, fileId) {
  const chunkIds = db.prepare('SELECT id FROM chunks WHERE file_id = ?').all(fileId);
  const del = db.prepare('DELETE FROM chunks_vec WHERE rowid = ?');
  for (const row of chunkIds) {
    del.run(row.id);
  }
}

/**
 * Find the k nearest chunk IDs to a query embedding using sqlite-vec.
 * Returns results sorted by distance (ascending = most similar first).
 *
 * @param {Object} db - SQLite database instance
 * @param {Float32Array} queryEmbedding - Query vector
 * @param {number} k - Number of nearest neighbors to return (default 200)
 * @returns {Array<{rowid: number, distance: number}>}
 */
export function vecSearch(db, queryEmbedding, k = 200) {
  return db
    .prepare('SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?')
    .all(embeddingToBlob(queryEmbedding), k);
}
