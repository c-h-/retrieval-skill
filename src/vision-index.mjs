/**
 * Vision Indexer — indexes PDF pages as image embeddings using ColQwen2.5.
 *
 * Parallel to the text indexer (index.mjs), this module:
 * 1. Extracts page images from PDFs
 * 2. Embeds each page via the vision adapter (multi-vector ColBERT-style)
 * 3. Stores page image metadata and vectors in SQLite
 * 4. Supports incremental indexing (skip pages by image hash)
 */

import { mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createVisionAdapter } from './adapters/vision-adapter.mjs';
import { openDb, setMeta } from './schema.mjs';
import { sha256 } from './utils.mjs';

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
 * @param {boolean} opts.extractText - Also extract text for FTS search (default false)
 * @returns {Object} Stats: { pages, skipped, errors, totalPages, totalVectors, ocrPages }
 */
export async function indexPdfVision(pdfPath, name, opts = {}) {
  const batchSize = opts.batchSize || 2;
  const extractText = opts.extractText || false;
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
    'SELECT id, image_hash FROM page_images WHERE document_id = ? AND page_number = ?',
  );
  const insertPage = db.prepare(`
    INSERT OR REPLACE INTO page_images (document_id, page_number, image_hash, adapter_name, num_vectors, source_path, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const deletePageVectors = db.prepare('DELETE FROM page_vectors WHERE page_image_id = ?');
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
    const _batchPageNums = [];

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

        const result = insertPage.run(documentId, pageNum, imgHash, adapter.name, numVectors, imgPath, now);
        const pageImageId = result.lastInsertRowid;

        // Insert all vectors for this page
        for (let vi = 0; vi < pageVectors.length; vi++) {
          const blob = adapter.embeddingToBlob(pageVectors[vi]);
          insertVector.run(pageImageId, vi, blob);
        }

        indexed++;
      }
    })();

    console.error(
      `[vision-index] Progress: ${indexed + skipped}/${pageCount} pages (${indexed} embedded, ${skipped} cached)`,
    );
  }

  // Store stats
  const totalPages = db.prepare('SELECT COUNT(*) as cnt FROM page_images WHERE document_id = ?').get(documentId).cnt;
  const totalVectors = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM page_vectors pv JOIN page_images pi ON pv.page_image_id = pi.id WHERE pi.document_id = ?',
    )
    .get(documentId).cnt;

  setMeta(db, 'last_vision_indexed_at', new Date().toISOString());
  setMeta(db, 'total_pages', String(totalPages));
  setMeta(db, 'total_page_vectors', String(totalVectors));

  // OCR / text extraction step
  let ocrPages = 0;
  if (extractText) {
    console.error(`[vision-index] Extracting text from PDF pages...`);
    try {
      const textResult = await adapter.extractText(pdfPath);
      const pagesWithText = textResult.pages.filter((p) => p.text.length > 0);
      ocrPages = textResult.pages.filter((p) => p.method === 'tesseract').length;

      if (pagesWithText.length > 0) {
        // Store as a synthetic file in the text pipeline for FTS search
        const syntheticPath = `pdf://${pdfPath}`;
        const textContent = pagesWithText.map((p) => `[Page ${p.page_number + 1}]\n${p.text}`).join('\n\n');
        const contentHash = sha256(textContent);

        const existingFile = db.prepare('SELECT id FROM files WHERE path = ?').get(syntheticPath);
        const now = new Date().toISOString();

        let fileId;
        if (existingFile) {
          db.prepare('UPDATE files SET content_hash = ?, mtime_ms = ?, indexed_at = ? WHERE id = ?').run(
            contentHash,
            Date.now(),
            now,
            existingFile.id,
          );
          // Clean old FTS entries
          const oldChunks = db.prepare('SELECT id, content FROM chunks WHERE file_id = ?').all(existingFile.id);
          for (const c of oldChunks) {
            db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, content, file_path) VALUES('delete', ?, ?, ?)").run(
              c.id,
              c.content,
              syntheticPath,
            );
          }
          db.prepare('DELETE FROM chunks WHERE file_id = ?').run(existingFile.id);
          fileId = existingFile.id;
        } else {
          const result = db
            .prepare('INSERT INTO files (path, content_hash, size, mtime_ms, indexed_at) VALUES (?, ?, ?, ?, ?)')
            .run(syntheticPath, contentHash, textContent.length, Date.now(), now);
          fileId = result.lastInsertRowid;
        }

        // Insert page text as chunks (one chunk per page with text)
        for (let i = 0; i < pagesWithText.length; i++) {
          const page = pagesWithText[i];
          const chunkContent = `[Page ${page.page_number + 1}] ${page.text}`;
          // Use a zero-filled embedding placeholder — these chunks are FTS-only
          const emptyBlob = Buffer.alloc(4); // minimal valid BLOB
          const hash = sha256(chunkContent);
          const result = db
            .prepare(
              'INSERT INTO chunks (file_id, chunk_index, content, embedding, content_hash, section_context) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(fileId, i, chunkContent, emptyBlob, hash, `Page ${page.page_number + 1}`);
          db.prepare('INSERT INTO chunks_fts (rowid, content, file_path) VALUES (?, ?, ?)').run(
            result.lastInsertRowid,
            chunkContent,
            syntheticPath,
          );
        }

        console.error(`[vision-index] Stored text from ${pagesWithText.length} pages (${ocrPages} via OCR)`);
        if (!textResult.has_tesseract) {
          const imageOnlyCount = textResult.pages.filter((p) => p.text.length === 0).length;
          if (imageOnlyCount > 0) {
            console.error(`[vision-index] ${imageOnlyCount} image-only pages skipped (install pytesseract for OCR)`);
          }
        }
      }
    } catch (err) {
      console.error(`[vision-index] Text extraction failed: ${err.message}`);
    }
  }

  db.close();
  await adapter.dispose();

  const stats = { indexed, skipped, errors, totalPages, totalVectors, ocrPages };
  console.error(`\n[vision-index] Done: ${indexed} pages embedded, ${skipped} cached, ${errors} errors`);
  console.error(`[vision-index] Total: ${totalPages} pages, ${totalVectors} vectors in "${name}"`);
  return stats;
}
