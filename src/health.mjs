import { listIndexes } from './index.mjs';

export async function checkEmbeddingServer({
  url = process.env.EMBEDDING_SERVER_URL || 'http://localhost:8100',
  timeoutMs = 5000,
} = {}) {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, statusCode: res.status };
    }
    let data = {};
    try {
      data = await res.json();
    } catch {
      // non-JSON body is fine
    }
    const result = { ok: true, statusCode: res.status };
    if (data.uptime_seconds != null) result.uptimeSeconds = data.uptime_seconds;
    if (data.error_count != null) result.errorCount = data.error_count;
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function getIndexStaleness({ thresholdHours = 48 } = {}) {
  const indexes = listIndexes();
  const now = Date.now();
  return indexes.map((idx) => {
    if (idx.error) {
      return { name: idx.name, lastIndexedAt: null, ageHours: null, stale: true, files: null, chunks: null };
    }
    const lastIndexedAt = idx.lastIndexedAt || null;
    let ageHours = null;
    let stale = true;
    if (lastIndexedAt) {
      const ms = now - new Date(lastIndexedAt).getTime();
      ageHours = Math.round((ms / (1000 * 60 * 60)) * 10) / 10;
      stale = ageHours > thresholdHours;
    }
    return {
      name: idx.name,
      lastIndexedAt,
      ageHours,
      stale,
      files: idx.totalFiles != null ? parseInt(idx.totalFiles, 10) : null,
      chunks: idx.totalChunks != null ? parseInt(idx.totalChunks, 10) : null,
    };
  });
}
