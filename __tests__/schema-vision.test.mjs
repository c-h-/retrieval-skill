import { describe, it, expect, afterEach } from 'vitest';
import { openDb, getMeta, setMeta } from '../src/schema.mjs';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DB_DIR = join(tmpdir(), 'retrieval-test-vision');

function testDbPath(name) {
  mkdirSync(TEST_DB_DIR, { recursive: true });
  return join(TEST_DB_DIR, `${name}.db`);
}

function cleanup(dbPath) {
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (existsSync(p)) unlinkSync(p);
  }
}

describe('schema vision tables', () => {
  let dbPath;

  afterEach(() => {
    if (dbPath) cleanup(dbPath);
  });

  it('creates vision tables when vision=true', () => {
    dbPath = testDbPath('vision-test-1');
    const db = openDb(dbPath, { vision: true });

    // Verify page_images table exists
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('page_images');
    expect(tableNames).toContain('page_vectors');

    db.close();
  });

  it('does not create vision tables when vision=false (default)', () => {
    dbPath = testDbPath('vision-test-2');
    const db = openDb(dbPath);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const tableNames = tables.map(t => t.name);
    expect(tableNames).not.toContain('page_images');
    expect(tableNames).not.toContain('page_vectors');

    // But text tables should exist
    expect(tableNames).toContain('files');
    expect(tableNames).toContain('chunks');
    expect(tableNames).toContain('meta');

    db.close();
  });

  it('can insert and query page_images and page_vectors', () => {
    dbPath = testDbPath('vision-test-3');
    const db = openDb(dbPath, { vision: true });

    // Insert a page image
    db.prepare(`
      INSERT INTO page_images (document_id, page_number, image_hash, adapter_name, num_vectors, source_path, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('doc123', 0, 'hash_abc', 'colqwen25-vision', 3, '/tmp/page_0.png', new Date().toISOString());

    const page = db.prepare('SELECT * FROM page_images WHERE document_id = ?').get('doc123');
    expect(page).toBeTruthy();
    expect(page.page_number).toBe(0);
    expect(page.num_vectors).toBe(3);

    // Insert vectors
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const blob = Buffer.from(embedding.buffer);
    db.prepare('INSERT INTO page_vectors (page_image_id, vector_index, embedding) VALUES (?, ?, ?)').run(page.id, 0, blob);
    db.prepare('INSERT INTO page_vectors (page_image_id, vector_index, embedding) VALUES (?, ?, ?)').run(page.id, 1, blob);

    const vectors = db.prepare('SELECT * FROM page_vectors WHERE page_image_id = ?').all(page.id);
    expect(vectors.length).toBe(2);

    // Verify BLOB roundtrip
    const readBack = new Float32Array(vectors[0].embedding.buffer, vectors[0].embedding.byteOffset, vectors[0].embedding.byteLength / 4);
    expect(readBack[0]).toBeCloseTo(0.1);
    expect(readBack[3]).toBeCloseTo(0.4);

    db.close();
  });

  it('cascades deletes from page_images to page_vectors', () => {
    dbPath = testDbPath('vision-test-4');
    const db = openDb(dbPath, { vision: true });

    db.prepare(`
      INSERT INTO page_images (document_id, page_number, image_hash, adapter_name, num_vectors, source_path, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('doc456', 0, 'hash_xyz', 'colqwen25-vision', 1, '/tmp/page.png', new Date().toISOString());

    const page = db.prepare('SELECT id FROM page_images WHERE document_id = ?').get('doc456');
    const blob = Buffer.from(new Float32Array([1, 2, 3, 4]).buffer);
    db.prepare('INSERT INTO page_vectors (page_image_id, vector_index, embedding) VALUES (?, ?, ?)').run(page.id, 0, blob);

    // Delete the page
    db.prepare('DELETE FROM page_images WHERE id = ?').run(page.id);

    // Vectors should be cascade-deleted
    const remainingVectors = db.prepare('SELECT COUNT(*) as cnt FROM page_vectors').get();
    expect(remainingVectors.cnt).toBe(0);

    db.close();
  });

  it('upgrades existing DB with vision tables', () => {
    dbPath = testDbPath('vision-test-5');

    // First open without vision
    let db = openDb(dbPath);
    const v1 = getMeta(db, 'schema_version');
    db.close();

    // Re-open with vision
    db = openDb(dbPath, { vision: true });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all();
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain('page_images');
    expect(tableNames).toContain('page_vectors');

    // Text tables still intact
    expect(tableNames).toContain('files');
    expect(tableNames).toContain('chunks');

    db.close();
  });
});
