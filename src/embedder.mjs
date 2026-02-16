/**
 * Embedding client — calls the local Octen-Embedding-8B MLX server
 * instead of running an in-process ONNX model.
 *
 * Server: http://localhost:8100/v1/embeddings (OpenAI-compatible)
 * Model:  Octen/Octen-Embedding-8B via MLX (4096-dim, last-token pooling)
 */

const SERVER_URL = process.env.EMBEDDING_SERVER_URL || 'http://localhost:8100';
const MODEL_ID = 'Octen/Octen-Embedding-8B';
const EMBEDDING_DIM = 4096;

/**
 * Call the embedding server. Returns array of Float32Array embeddings.
 */
async function callServer(texts, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${SERVER_URL}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: texts, model: MODEL_ID }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Embedding server error (${res.status}): ${body}`);
      }
      const json = await res.json();
      const sorted = json.data.sort((a, b) => a.index - b.index);
      return sorted.map(d => new Float32Array(d.embedding));
    } catch (err) {
      if (attempt < retries && (err.code === 'UND_ERR_SOCKET' || err.cause?.code === 'UND_ERR_SOCKET' || err.message.includes('socket') || err.message.includes('ECONNRESET'))) {
        const delay = attempt * 2000;
        console.error(`Embedding request failed (attempt ${attempt}/${retries}), retrying in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

/**
 * No-op — the model lives on the server. Kept for API compatibility.
 */
export async function loadModel(_opts = {}) {
  // Verify the server is reachable
  const res = await fetch(`${SERVER_URL}/health`);
  if (!res.ok) throw new Error(`Embedding server not healthy: ${res.status}`);
  return true;
}

/**
 * Embed a batch of document texts. No query prefix applied.
 * Automatically batches into chunks of BATCH_SIZE to avoid timeouts on large docs.
 * Returns array of Float32Array embeddings.
 */
const BATCH_SIZE = 32;

export async function embedDocuments(texts) {
  if (!texts.length) return [];
  if (texts.length <= BATCH_SIZE) return callServer(texts);

  // Batch large requests
  const results = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await callServer(batch);
    results.push(...embeddings);
  }
  return results;
}

/**
 * Embed a single query.
 * Returns Float32Array embedding.
 */
export async function embedQuery(query) {
  const [embedding] = await callServer([query]);
  return embedding;
}

/**
 * Convert Float32Array to Buffer for SQLite BLOB storage.
 */
export function embeddingToBlob(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

/**
 * Convert SQLite BLOB back to Float32Array.
 */
export function blobToEmbedding(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

export function getModelId() {
  return MODEL_ID;
}

export function getEmbeddingDim() {
  return EMBEDDING_DIM;
}
