/**
 * E2E test for vision embedding pipeline.
 *
 * Tests the full flow: PDF → page extraction → ColQwen2.5 embedding →
 * SQLite storage → MaxSim search.
 *
 * Requires:
 * - Python venv with ColQwen2.5 dependencies installed
 * - ~/Downloads/Skinnytaste meal prep gina homolka.pdf
 *
 * Run with: npx vitest run __tests__/vision-e2e.test.mjs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { openDb, getMeta } from '../src/schema.mjs';
import { indexPdfVision } from '../src/vision-index.mjs';
import { searchVisionIndex } from '../src/search/maxsim.mjs';
import { createVisionAdapter } from '../src/adapters/vision-adapter.mjs';

const PDF_PATH = join(homedir(), 'Downloads', 'Skinnytaste meal prep gina homolka.pdf');
const TEST_INDEX_NAME = 'skinnytaste-vision-test';
const INDEX_DIR = join(homedir(), '.retrieval-skill', 'indexes');
const DB_PATH = join(INDEX_DIR, `${TEST_INDEX_NAME}.db`);

// Skip if PDF not available
const pdfExists = existsSync(PDF_PATH);

describe.skipIf(!pdfExists)('Vision E2E: Skinnytaste PDF', () => {
  let indexStats;

  beforeAll(async () => {
    // Clean previous test index
    for (const ext of ['', '-wal', '-shm']) {
      const p = DB_PATH + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  }, 600000);

  it('indexes the PDF with vision embeddings', async () => {
    // Index first 5 pages only for speed (use batchSize=1 for stability)
    indexStats = await indexPdfVision(PDF_PATH, TEST_INDEX_NAME, { batchSize: 1 });

    expect(indexStats.totalPages).toBeGreaterThan(0);
    expect(indexStats.totalVectors).toBeGreaterThan(0);
    expect(indexStats.errors).toBe(0);

    console.log('Index stats:', JSON.stringify(indexStats, null, 2));
  }, 600000); // 10 min timeout for model download + embedding

  it('has correct schema and metadata', () => {
    const db = openDb(DB_PATH, { vision: true });

    expect(getMeta(db, 'vision_adapter')).toBe('colqwen25-vision');
    expect(getMeta(db, 'vision_model_id')).toBe('tsystems/colqwen2.5-3b-multilingual-v1.0-merged');
    expect(getMeta(db, 'total_pages')).toBeTruthy();

    const pages = db.prepare('SELECT COUNT(*) as cnt FROM page_images').get();
    expect(pages.cnt).toBeGreaterThan(0);

    const vectors = db.prepare('SELECT COUNT(*) as cnt FROM page_vectors').get();
    expect(vectors.cnt).toBeGreaterThan(0);

    db.close();
  }, 30000);

  it('searches with MaxSim and returns relevant results', async () => {
    const adapter = createVisionAdapter();
    await adapter.init();

    const queries = [
      'vegetarian pasta under 30 minutes',
      'high protein meal prep',
      'quick breakfast ideas',
    ];

    for (const query of queries) {
      const queryVectors = await adapter.embedQuery(query);
      expect(queryVectors.length).toBeGreaterThan(0);
      expect(queryVectors[0].length).toBeGreaterThan(0);

      const db = openDb(DB_PATH, { vision: true });
      const results = searchVisionIndex(db, queryVectors, 5);
      db.close();

      console.log(`\nQuery: "${query}"`);
      console.log(`Results: ${results.length} pages`);
      for (const r of results.slice(0, 3)) {
        console.log(`  Page ${r.pageNumber + 1}: score=${r.score.toFixed(2)}`);
      }

      expect(results.length).toBeGreaterThan(0);
      // MaxSim scores should be positive for relevant queries
      expect(results[0].score).toBeGreaterThan(0);
    }

    await adapter.dispose();
  }, 300000); // 5 min timeout

  it('supports incremental indexing (second run skips cached pages)', async () => {
    const stats2 = await indexPdfVision(PDF_PATH, TEST_INDEX_NAME, { batchSize: 1 });

    console.log('Second index stats:', JSON.stringify(stats2, null, 2));
    // All pages should be skipped (already indexed with same hash)
    expect(stats2.skipped).toBeGreaterThan(0);
    expect(stats2.indexed).toBe(0);
  }, 600000);

  afterAll(async () => {
    // Cleanup test index
    for (const ext of ['', '-wal', '-shm']) {
      const p = DB_PATH + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  });
});
