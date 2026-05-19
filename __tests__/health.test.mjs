import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkEmbeddingServer, getIndexStaleness } from '../src/health.mjs';

vi.mock('../src/index.mjs', () => ({
  listIndexes: vi.fn(),
}));

import { listIndexes } from '../src/index.mjs';

describe('checkEmbeddingServer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ok:true with statusCode and optional fields on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', uptime_seconds: 3600, error_count: 0 }),
      }),
    );
    const result = await checkEmbeddingServer({ url: 'http://localhost:8100' });
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.uptimeSeconds).toBe(3600);
    expect(result.errorCount).toBe(0);
  });

  it('returns ok:false with statusCode on 502', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
      }),
    );
    const result = await checkEmbeddingServer({ url: 'http://localhost:8100' });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(502);
  });

  it('returns ok:false with error on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await checkEmbeddingServer({ url: 'http://localhost:8100' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('returns ok:false on timeout (AbortError)', async () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    const result = await checkEmbeddingServer({ url: 'http://localhost:8100', timeoutMs: 100 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('omits optional fields when not in response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok' }),
      }),
    );
    const result = await checkEmbeddingServer({ url: 'http://localhost:8100' });
    expect(result.ok).toBe(true);
    expect(result.uptimeSeconds).toBeUndefined();
    expect(result.errorCount).toBeUndefined();
  });
});

describe('getIndexStaleness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks a recently indexed index as fresh', () => {
    const now = new Date().toISOString();
    listIndexes.mockReturnValue([{ name: 'slack', lastIndexedAt: now, totalFiles: '100', totalChunks: '500' }]);
    const result = getIndexStaleness({ thresholdHours: 48 });
    expect(result).toHaveLength(1);
    expect(result[0].stale).toBe(false);
    expect(result[0].ageHours).toBeLessThan(1);
    expect(result[0].files).toBe(100);
    expect(result[0].chunks).toBe(500);
  });

  it('marks an old index as stale', () => {
    const old = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
    listIndexes.mockReturnValue([{ name: 'mono', lastIndexedAt: old, totalFiles: '200', totalChunks: '1000' }]);
    const result = getIndexStaleness({ thresholdHours: 48 });
    expect(result[0].stale).toBe(true);
    expect(result[0].ageHours).toBeGreaterThan(49);
  });

  it('marks an index with null lastIndexedAt as stale', () => {
    listIndexes.mockReturnValue([{ name: 'notion', lastIndexedAt: null, totalFiles: '50', totalChunks: '200' }]);
    const result = getIndexStaleness({ thresholdHours: 48 });
    expect(result[0].stale).toBe(true);
    expect(result[0].ageHours).toBeNull();
    expect(result[0].lastIndexedAt).toBeNull();
  });

  it('handles a mix of fresh, stale, and missing timestamps', () => {
    const fresh = new Date().toISOString();
    const old = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    listIndexes.mockReturnValue([
      { name: 'slack', lastIndexedAt: fresh, totalFiles: '100', totalChunks: '500' },
      { name: 'mono', lastIndexedAt: old, totalFiles: '200', totalChunks: '1000' },
      { name: 'notion', lastIndexedAt: null, totalFiles: null, totalChunks: null },
    ]);
    const result = getIndexStaleness({ thresholdHours: 48 });
    expect(result[0].stale).toBe(false);
    expect(result[1].stale).toBe(true);
    expect(result[2].stale).toBe(true);
  });

  it('marks errored indexes as stale with null fields', () => {
    listIndexes.mockReturnValue([{ name: 'linear', error: 'Could not read index' }]);
    const result = getIndexStaleness({ thresholdHours: 48 });
    expect(result[0].stale).toBe(true);
    expect(result[0].lastIndexedAt).toBeNull();
    expect(result[0].ageHours).toBeNull();
    expect(result[0].files).toBeNull();
    expect(result[0].chunks).toBeNull();
  });

  it('returns empty array when no indexes exist', () => {
    listIndexes.mockReturnValue([]);
    const result = getIndexStaleness({ thresholdHours: 48 });
    expect(result).toHaveLength(0);
  });
});
