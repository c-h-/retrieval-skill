/**
 * EmbeddingAdapter interface definition.
 *
 * All embedding adapters (text, vision) implement this shape.
 * Text adapters produce single-vector embeddings per chunk.
 * Vision adapters produce multi-vector embeddings per page image.
 */

/**
 * @typedef {Object} EmbeddingAdapter
 * @property {string} name - Unique adapter identifier
 * @property {string} type - 'text' | 'vision'
 * @property {() => Promise<void>} init - Initialize the adapter (load model, verify health)
 * @property {(query: string) => Promise<Float32Array|Float32Array[]>} embedQuery
 *   Text: returns single Float32Array. Vision: returns array of Float32Array (multi-vector).
 * @property {(texts: string[]) => Promise<Float32Array[]>} embedDocuments
 *   Embed an array of text documents. Only for text adapters.
 * @property {(images: Buffer[]) => Promise<Float32Array[][]>} embedImages
 *   Embed an array of page images. Returns array of multi-vector arrays. Only for vision adapters.
 * @property {() => number} embeddingDim - Dimension of each embedding vector
 * @property {() => string} modelId - Model identifier string
 * @property {() => Promise<void>} dispose - Clean up resources
 */

/**
 * Validate that an object conforms to the EmbeddingAdapter interface.
 */
export function validateAdapter(adapter) {
  const required = ['name', 'type', 'init', 'embedQuery', 'embeddingDim', 'modelId', 'dispose'];
  for (const key of required) {
    if (adapter[key] === undefined) {
      throw new Error(`Adapter missing required property: ${key}`);
    }
  }
  if (adapter.type === 'text' && typeof adapter.embedDocuments !== 'function') {
    throw new Error('Text adapter must implement embedDocuments()');
  }
  if (adapter.type === 'vision' && typeof adapter.embedImages !== 'function') {
    throw new Error('Vision adapter must implement embedImages()');
  }
  return true;
}

/** Adapter registry — singleton map of name → adapter instance */
const registry = new Map();

export function registerAdapter(adapter) {
  validateAdapter(adapter);
  registry.set(adapter.name, adapter);
}

export function getAdapter(name) {
  const adapter = registry.get(name);
  if (!adapter) throw new Error(`No adapter registered with name: ${name}`);
  return adapter;
}

export function getAdaptersByType(type) {
  return [...registry.values()].filter(a => a.type === type);
}

export function listAdapters() {
  return [...registry.values()].map(a => ({ name: a.name, type: a.type, modelId: a.modelId() }));
}

export function clearRegistry() {
  registry.clear();
}
