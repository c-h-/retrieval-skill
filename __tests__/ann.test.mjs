import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annCandidates, buildAnnIndex, hasAnnIndex, kmeans } from '../src/ann.mjs';
import { embeddingToBlob } from '../src/embedder.mjs';
import { openDb } from '../src/schema.mjs';

// Small embedding dimension for tests (real system uses 4096)
const DIM = 32;

function randomVec(dim = DIM) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() - 0.5;
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

function clusterVec(center, noise = 0.05) {
  const v = new Float32Array(center.length);
  for (let i = 0; i < center.length; i++) {
    v[i] = center[i] + (Math.random() - 0.5) * noise;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

describe('kmeans', () => {
  it('produces the requested number of centroids', () => {
    const vectors = Array.from({ length: 100 }, () => randomVec());
    const centroids = kmeans(vectors, 5);
    expect(centroids).toHaveLength(5);
    expect(centroids[0]).toHaveLength(DIM);
  });

  it('finds cluster structure in well-separated data', () => {
    // Create 3 well-separated clusters
    const c1 = new Float32Array(DIM).fill(0);
    c1[0] = 1;
    const c2 = new Float32Array(DIM).fill(0);
    c2[1] = 1;
    const c3 = new Float32Array(DIM).fill(0);
    c3[2] = 1;

    const vectors = [
      ...Array.from({ length: 30 }, () => clusterVec(c1)),
      ...Array.from({ length: 30 }, () => clusterVec(c2)),
      ...Array.from({ length: 30 }, () => clusterVec(c3)),
    ];

    const centroids = kmeans(vectors, 3);
    expect(centroids).toHaveLength(3);

    // Each centroid should be close to one of the true centers
    // (dominant dimension should have the highest value)
    const dominantDims = centroids.map((c) => {
      let maxVal = -Infinity;
      let maxIdx = 0;
      for (let i = 0; i < c.length; i++) {
        if (c[i] > maxVal) {
          maxVal = c[i];
          maxIdx = i;
        }
      }
      return maxIdx;
    });
    const uniqueDims = new Set(dominantDims);
    expect(uniqueDims.size).toBe(3);
  });
});

describe('ANN index (buildAnnIndex / hasAnnIndex / annCandidates)', () => {
  const DB_PATH = join(tmpdir(), `ann-test-${Date.now()}.db`);
  let db;

  beforeEach(() => {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    db = openDb(DB_PATH);

    // Insert a synthetic file
    db.prepare('INSERT INTO files (path, content_hash, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)').run(
      '/test/file.md',
      'abc123',
      100,
      Date.now(),
      new Date().toISOString(),
    );
    const fileId = 1;

    // Create 3 clusters of vectors (50 chunks each = 150 total)
    const centers = [
      (() => {
        const v = new Float32Array(DIM).fill(0);
        v[0] = 1;
        return v;
      })(),
      (() => {
        const v = new Float32Array(DIM).fill(0);
        v[1] = 1;
        return v;
      })(),
      (() => {
        const v = new Float32Array(DIM).fill(0);
        v[2] = 1;
        return v;
      })(),
    ];

    const insertChunk = db.prepare(
      'INSERT INTO chunks (file_id, chunk_index, content, embedding, content_hash) VALUES (?, ?, ?, ?, ?)',
    );
    const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, content, file_path) VALUES (?, ?, ?)');

    let chunkIdx = 0;
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < 50; i++) {
        const vec = clusterVec(centers[c], 0.05);
        const blob = embeddingToBlob(vec);
        const result = insertChunk.run(fileId, chunkIdx, `chunk ${chunkIdx}`, blob, `hash${chunkIdx}`);
        insertFts.run(result.lastInsertRowid, `chunk ${chunkIdx}`, '/test/file.md');
        chunkIdx++;
      }
    }
  });

  afterEach(() => {
    if (db) db.close();
    for (const ext of ['', '-wal', '-shm']) {
      const p = DB_PATH + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it('hasAnnIndex returns false before building', () => {
    expect(hasAnnIndex(db)).toBe(false);
  });

  it('builds an ANN index', () => {
    const result = buildAnnIndex(db, { minChunks: 10 });
    expect(result.built).toBe(true);
    expect(result.numClusters).toBeGreaterThan(0);
    expect(result.numChunks).toBe(150);
  });

  it('hasAnnIndex returns true after building', () => {
    buildAnnIndex(db, { minChunks: 10 });
    expect(hasAnnIndex(db)).toBe(true);
  });

  it('skips building when below minChunks threshold', () => {
    const result = buildAnnIndex(db, { minChunks: 10000 });
    expect(result.built).toBe(false);
  });

  it('returns candidates from the correct cluster', () => {
    buildAnnIndex(db, { minChunks: 10 });

    // Query near cluster 0 (dominant dimension 0)
    const query = new Float32Array(DIM).fill(0);
    query[0] = 1;

    const candidates = annCandidates(db, query, 1);
    expect(candidates.size).toBeGreaterThan(0);
    // Should return roughly 50 candidates (the cluster near dimension 0)
    expect(candidates.size).toBeLessThan(150);

    // Query near cluster 1
    const query2 = new Float32Array(DIM).fill(0);
    query2[1] = 1;
    const candidates2 = annCandidates(db, query2, 1);
    expect(candidates2.size).toBeGreaterThan(0);

    // The two candidate sets should be mostly disjoint
    let overlap = 0;
    for (const id of candidates) {
      if (candidates2.has(id)) overlap++;
    }
    expect(overlap).toBeLessThan(candidates.size * 0.5);
  });

  it('returns more candidates with higher nprobe', () => {
    buildAnnIndex(db, { minChunks: 10 });

    const query = new Float32Array(DIM).fill(0);
    query[0] = 1;

    const small = annCandidates(db, query, 1);
    const large = annCandidates(db, query, 100);
    expect(large.size).toBeGreaterThanOrEqual(small.size);
  });
});
