/**
 * TextEmbeddingAdapter — wraps existing Octen-Embedding-8B embedder
 * into the EmbeddingAdapter interface. Zero functional changes to underlying logic.
 */

import * as embedder from '../embedder.mjs';

export function createTextAdapter() {
  return {
    name: 'octen-text',
    type: 'text',

    async init() {
      await embedder.loadModel();
    },

    async embedQuery(query) {
      return embedder.embedQuery(query);
    },

    async embedDocuments(texts) {
      return embedder.embedDocuments(texts);
    },

    // Not applicable for text adapter
    async embedImages(_images) {
      throw new Error('Text adapter does not support image embedding');
    },

    embeddingDim() {
      return embedder.getEmbeddingDim();
    },

    modelId() {
      return embedder.getModelId();
    },

    embeddingToBlob(embedding) {
      return embedder.embeddingToBlob(embedding);
    },

    blobToEmbedding(blob) {
      return embedder.blobToEmbedding(blob);
    },

    async dispose() {
      // No-op: server-based embedder has no local resources
    },
  };
}
