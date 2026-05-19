import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reindexAllWithRetry } from '../src/reindex-with-retry.mjs';

vi.mock('../src/index.mjs', () => ({
  reindexByName: vi.fn(),
}));

vi.mock('../src/health.mjs', () => ({
  checkEmbeddingServer: vi.fn(),
}));

import { checkEmbeddingServer } from '../src/health.mjs';
import { reindexByName } from '../src/index.mjs';

describe('reindexAllWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    checkEmbeddingServer.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('all succeed on first attempt', async () => {
    reindexByName.mockResolvedValue({ indexed: 10, skipped: 0 });
    const promise = reindexAllWithRetry({
      indexes: ['slack', 'notion'],
      maxAttempts: 3,
      backoffMs: [1000, 2000],
      healthCheckBetweenAttempts: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.allOk).toBe(true);
    expect(result.summary).toHaveLength(2);
    expect(result.summary[0].status).toBe('ok');
    expect(result.summary[0].attempts).toBe(1);
    expect(result.summary[1].status).toBe('ok');
    expect(result.summary[1].attempts).toBe(1);
  });

  it('retries on failure and succeeds on third attempt', async () => {
    let calls = 0;
    reindexByName.mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('temporary failure');
      return { indexed: 5 };
    });
    const promise = reindexAllWithRetry({
      indexes: ['mono'],
      maxAttempts: 3,
      backoffMs: [100, 200],
      healthCheckBetweenAttempts: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.allOk).toBe(true);
    expect(result.summary[0].status).toBe('ok');
    expect(result.summary[0].attempts).toBe(3);
  });

  it('marks index as failed after exhausting all attempts', async () => {
    reindexByName.mockRejectedValue(new Error('persistent failure'));
    const promise = reindexAllWithRetry({
      indexes: ['mono'],
      maxAttempts: 3,
      backoffMs: [100, 200],
      healthCheckBetweenAttempts: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.allOk).toBe(false);
    expect(result.summary[0].status).toBe('failed');
    expect(result.summary[0].attempts).toBe(3);
    expect(result.summary[0].error).toBe('persistent failure');
  });

  it('independent retry budget: one fails all attempts while others succeed', async () => {
    reindexByName.mockImplementation(async (name) => {
      if (name === 'mono') throw new Error('mono broken');
      return { indexed: 5 };
    });
    const promise = reindexAllWithRetry({
      indexes: ['slack', 'mono', 'notion'],
      maxAttempts: 2,
      backoffMs: [100],
      healthCheckBetweenAttempts: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.allOk).toBe(false);
    const slack = result.summary.find((s) => s.name === 'slack');
    const mono = result.summary.find((s) => s.name === 'mono');
    const notion = result.summary.find((s) => s.name === 'notion');
    expect(slack.status).toBe('ok');
    expect(mono.status).toBe('failed');
    expect(notion.status).toBe('ok');
  });

  it('detects provider-failover-502 error message and records it', async () => {
    reindexByName.mockRejectedValue(new Error('all providers in failover chain failed: 502 Bad Gateway'));
    const promise = reindexAllWithRetry({
      indexes: ['mono'],
      maxAttempts: 2,
      backoffMs: [100],
      healthCheckBetweenAttempts: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.allOk).toBe(false);
    expect(result.summary[0].error).toMatch(/502|failover/i);
  });

  it('aborts remaining retries when embedding server is unhealthy between attempts', async () => {
    reindexByName.mockImplementation(async () => {
      throw new Error('server error');
    });
    checkEmbeddingServer.mockResolvedValue({ ok: false });
    const promise = reindexAllWithRetry({
      indexes: ['mono'],
      maxAttempts: 3,
      backoffMs: [100, 200],
      healthCheckBetweenAttempts: true,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.allOk).toBe(false);
    // 1 attempt: first fails, health check runs after sleep, health is bad → abort before attempt 2
    expect(result.summary[0].attempts).toBe(1);
  });

  it('summary entries are JSON-serializable', async () => {
    reindexByName.mockResolvedValue({ indexed: 1 });
    const promise = reindexAllWithRetry({
      indexes: ['slack'],
      maxAttempts: 1,
      backoffMs: [],
      healthCheckBetweenAttempts: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('allOk is true only when every index succeeds', async () => {
    reindexByName.mockImplementation(async (name) => {
      if (name === 'linear') throw new Error('linear failed');
      return {};
    });
    const promise = reindexAllWithRetry({
      indexes: ['slack', 'linear'],
      maxAttempts: 1,
      backoffMs: [],
      healthCheckBetweenAttempts: false,
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.allOk).toBe(false);
  });
});
