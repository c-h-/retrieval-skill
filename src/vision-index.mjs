/**
 * Vision Indexer — indexes PDF pages as image embeddings using ColQwen2.5.
 *
 * Parallel to the text indexer (index.mjs), this module:
 * 1. Extracts page images from PDFs
 * 2. Embeds each page via the vision adapter (multi-vector ColBERT-style)
 * 3. Stores page image metadata and vectors in SQLite
 * 4. Supports incremental indexing (skip pages by image hash)
 */

import { openDb, setMeta, getMeta } from './schema.mjs';
import { sha256 } from './utils.mjs';
import { createVisionAdapter } from './adapters/vision-adapter.mjs';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { readdir, unlink } from 'fs/promises';

const DEFAULT_INDEX_DIR = join(homedir(), '.retrieval-skill', 'indexes');
const PAGE_IMAGES_DIR = join(homedir(), '.retrieval-skill', 'page-images');

export function visionIndexDbPath(name) {
  return join(DEFAULT_INDEX_DIR, `${name}.db`);
}

/**
 * Index a PDF file with vision embeddings.
 * Creates page images and multi-vector embeddings.
 *
 * @param {string} pdfPath - Absolute path to the PDF
 * @param {string} name - Index name
 * @param {Object} opts - Options
 * @param {number} opts.batchSize - Pages to embed per batch (default 2)
 * @returns {Object} Stats: { pages, skipped, errors, totalPages, totalVectors }
 */
export async function indexPdfVision(pdfPath, name, opts = {}) {
  const batchSize = opts.batchSize || 2;
  const adapter = createVisionAdapter();

  console.error(`[vision-index] Initializing vision adapter...`);
  await adapter.init();

  const dbPath = visionIndexDbPath(name);
  const db = openDb(dbPath, { vision: true });

  // Store metadata
  const documentId = sha256(pdfPath);
  setMeta(db, 'index_name', name);
  setMeta(db, 'source_path', pdfPath);
  setMeta(db, 'vision_model_id', adapter.modelId());
  setMeta(db, 'vision_adapter', adapter.name);

  // Extract page images via Python bridge
  const outputDir = join(PAGE_IMAGES_DIR, name, documentId.slice(0, 12));
  mkdirSync(outputDir, { recursive: true });

  console.error(`[vision-index] Extracting pages from PDF...`);
  const { paths: imagePaths, page_count: pageCount } = await adapter.extractPages(pdfPath, outputDir);
  console.error(`[vision-index] Extracted ${pageCount} pages.`);

  // Prepare statements
  const getPageByDocPage = db.prepare(
    'SELECT id, image_hash FROM page_images WHERE document_id = ? AND page_number = ?'
  );
  const insertPage = db.prepare(`
    INSERT OR REPLACE INTO page_images (document_id, page_number, image_hash, adapter_name, num_vectors, source_path, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const deletePageVectors = db.prepare(
    'DELETE FROM page_vectors WHERE page_image_id = ?'
  );
  const insertVector = db.prepare(`
    INSERT INTO page_vectors (page_image_id, vector_index, embedding)
    VALUES (?, ?, ?)
  `);

  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  // Process pages in batches
  for (let batchStart = 0; batchStart < imagePaths.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, imagePaths.length);
    const batchPaths = imagePaths.slice(batchStart, batchEnd);
    const batchPageNums = [];

    // Check which pages need embedding
    const toEmbed = [];
    const toEmbedPageNums = [];

    for (let i = 0; i < batchPaths.length; i++) {
      const pageNum = batchStart + i;
      const imgData = readFileSync(batchPaths[i]);
      const imgHash = sha256(imgData.toString('base64'));

      const existing = getPageByDocPage.get(documentId, pageNum);
      if (existing && existing.image_hash === imgHash) {
        skipped++;
        continue;
      }

      toEmbed.push(batchPaths[i]);
      toEmbedPageNums.push({ pageNum, imgHash, imgPath: batchPaths[i] });
    }

    if (toEmbed.length === 0) continue;

    // Embed the batch
    let embeddings;
    try {
      const result = await adapter.embedImagesWithMeta(toEmbed);
      embeddings = result;
    } catch (err) {
      console.error(`[vision-index] Error embedding pages ${batchStart}-${batchEnd}: ${err.message}`);
      errors += toEmbed.length;
      continue;
    }

    // Store in DB transactionally
    db.transaction(() => {
      for (let i = 0; i < toEmbedPageNums.length; i++) {
        const { pageNum, imgHash, imgPath } = toEmbedPageNums[i];
        const pageVectors = embeddings.embeddings[i];
        const numVectors = embeddings.num_vectors[i];
        const now = new Date().toISOString();

        // Check if page already exists (for update case)
        const existing = getPageByDocPage.get(documentId, pageNum);
        if (existing) {
          deletePageVectors.run(existing.id);
        }

        const result = insertPage.run(
          documentId, pageNum, imgHash, adapter.name,
          numVectors, imgPath, now
        );
        const pageImageId = result.lastInsertRowid;

        // Insert all vectors for this page
        for (let vi = 0; vi < pageVectors.length; vi++) {
          const blob = adapter.embeddingToBlob(pageVectors[vi]);
          insertVector.run(pageImageId, vi, blob);
        }

        indexed++;
      }
    })();

    console.error(`[vision-index] Progress: ${indexed + skipped}/${pageCount} pages (${indexed} embedded, ${skipped} cached)`);
  }

  // Store stats
  const totalPages = db.prepare('SELECT COUNT(*) as cnt FROM page_images WHERE document_id = ?').get(documentId).cnt;
  const totalVectors = db.prepare(
    'SELECT COUNT(*) as cnt FROM page_vectors pv JOIN page_images pi ON pv.page_image_id = pi.id WHERE pi.document_id = ?'
  ).get(documentId).cnt;

  setMeta(db, 'last_vision_indexed_at', new Date().toISOString());
  setMeta(db, 'total_pages', String(totalPages));
  setMeta(db, 'total_page_vectors', String(totalVectors));

  db.close();
  await adapter.dispose();

  const stats = { indexed, skipped, errors, totalPages, totalVectors };
  console.error(`\n[vision-index] Done: ${indexed} pages embedded, ${skipped} cached, ${errors} errors`);
  console.error(`[vision-index] Total: ${totalPages} pages, ${totalVectors} vectors in "${name}"`);
  return stats;
}
