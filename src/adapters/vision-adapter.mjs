/**
 * VisionEmbeddingAdapter — ColQwen2.5 via Python bridge.
 *
 * Implements the EmbeddingAdapter interface for vision (multi-vector) embeddings.
 * Each page image produces ~700 token vectors of 128 dimensions each.
 */

import { VisionBridge } from '../vision/bridge.mjs';

const MODEL_IDS = {
  torch: 'tsystems/colqwen2.5-3b-multilingual-v1.0-merged',
  mlx: 'qnguyen3/colqwen2.5-v0.2-mlx',
};
const EMBEDDING_DIM = 128; // ColBERT-style 128-dim per token vector

export function createVisionAdapter({ backend } = {}) {
  let bridge = null;
  const resolvedBackend = backend || process.env.VISION_BACKEND || 'torch';

  return {
    name: 'colqwen25-vision',
    type: 'vision',

    async init() {
      bridge = new VisionBridge({ backend: resolvedBackend });
      await bridge.start();
    },

    /**
     * Embed a query text for multi-vector MaxSim matching.
     * Returns Float32Array[] — array of token vectors.
     */
    async embedQuery(query) {
      return bridge.embedQuery(query);
    },

    // Not applicable for vision adapter — use embedImages
    async embedDocuments(_texts) {
      throw new Error('Vision adapter does not support text document embedding');
    },

    /**
     * Embed page images. images is an array of file paths (strings).
     * Returns Float32Array[][] — for each image, an array of token vectors.
     */
    async embedImages(imagePaths) {
      const result = await bridge.embedImages(imagePaths);
      return result.embeddings;
    },

    /**
     * Extract page images from a PDF.
     */
    async extractPages(pdfPath, outputDir) {
      return bridge.extractPages(pdfPath, outputDir);
    },

    /**
     * Extract text from PDF pages (PyMuPDF + optional pytesseract OCR fallback).
     */
    async extractText(pdfPath) {
      return bridge.extractText(pdfPath);
    },

    /**
     * Get number of vectors per result. Useful post-embedding.
     */
    async embedImagesWithMeta(imagePaths) {
      return bridge.embedImages(imagePaths);
    },

    embeddingDim() {
      return EMBEDDING_DIM;
    },

    modelId() {
      return MODEL_IDS[resolvedBackend] || MODEL_IDS.torch;
    },

    /**
     * Convert a single 128-dim Float32Array to Buffer for SQLite BLOB.
     */
    embeddingToBlob(embedding) {
      return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    },

    /**
     * Convert SQLite BLOB back to Float32Array.
     */
    blobToEmbedding(blob) {
      return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    },

    async dispose() {
      if (bridge) {
        await bridge.stop();
        bridge = null;
      }
    },
  };
}
