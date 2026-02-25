import { existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteVec, deleteVecForFile, insertVec, vecSearch } from '../src/ann.mjs';
import { embeddingToBlob } from '../src/embedder.mjs';
import { openDb } from '../src/schema.mjs';

// Small embedding dimension for tests
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

describe('sqlite-vec integration (insertVec / vecSearch / deleteVec)', () => {
  const DB_PATH = join(tmpdir(), `vec-test-${Date.now()}.db`);
  let db;

  beforeEach(() => {
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    db = openDb(DB_PATH, { embeddingDim: DIM });

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
        insertVec(db, result.lastInsertRowid, vec);
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

  it('finds nearest neighbors for a query vector', () => {
    // Query near cluster 0 (dominant dimension 0)
    const query = new Float32Array(DIM).fill(0);
    query[0] = 1;

    const results = vecSearch(db, query, 10);
    expect(results.length).toBe(10);
    // Results should be sorted by distance ascending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
    // Nearest results should be close (small distance)
    expect(results[0].distance).toBeLessThan(0.5);
  });

  it('returns results from the correct cluster', () => {
    // Query near cluster 0
    const q0 = new Float32Array(DIM).fill(0);
    q0[0] = 1;
    const r0 = vecSearch(db, q0, 50);

    // Query near cluster 1
    const q1 = new Float32Array(DIM).fill(0);
    q1[1] = 1;
    const r1 = vecSearch(db, q1, 50);

    // The two result sets should be mostly disjoint
    const set0 = new Set(r0.map((r) => r.rowid));
    const set1 = new Set(r1.map((r) => r.rowid));
    let overlap = 0;
    for (const id of set0) {
      if (set1.has(id)) overlap++;
    }
    expect(overlap).toBeLessThan(set0.size * 0.5);
  });

  it('handles k larger than total rows', () => {
    const query = randomVec();
    const results = vecSearch(db, query, 1000);
    expect(results.length).toBe(150);
  });

  it('deleteVec removes a single entry', () => {
    const query = new Float32Array(DIM).fill(0);
    query[0] = 1;

    const before = vecSearch(db, query, 200);
    expect(before.length).toBe(150);

    deleteVec(db, before[0].rowid);

    const after = vecSearch(db, query, 200);
    expect(after.length).toBe(149);
    expect(after.find((r) => r.rowid === before[0].rowid)).toBeUndefined();
  });

  it('deleteVecForFile removes all entries for a file', () => {
    const query = randomVec();
    const before = vecSearch(db, query, 200);
    expect(before.length).toBe(150);

    deleteVecForFile(db, 1); // file_id = 1

    const after = vecSearch(db, query, 200);
    expect(after.length).toBe(0);
  });

  it('accepts Buffer blobs in insertVec', () => {
    // Insert a new chunk with a Buffer blob
    const vec = randomVec();
    const blob = embeddingToBlob(vec);
    const result = db
      .prepare('INSERT INTO chunks (file_id, chunk_index, content, embedding, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run(1, 999, 'buffer test', blob, 'hashbuf');

    insertVec(db, result.lastInsertRowid, blob); // pass Buffer, not Float32Array

    const results = vecSearch(db, vec, 1);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rowid).toBe(Number(result.lastInsertRowid));
    expect(results[0].distance).toBeLessThan(0.01);
  });
});
