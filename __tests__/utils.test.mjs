import { describe, expect, it } from 'vitest';
import { chunkHash, sha256 } from '../src/utils.mjs';

describe('sha256', () => {
  it('produces consistent hashes', () => {
    const hash1 = sha256('hello world');
    const hash2 = sha256('hello world');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different content', () => {
    const hash1 = sha256('hello');
    const hash2 = sha256('world');
    expect(hash1).not.toBe(hash2);
  });

  it('returns hex string', () => {
    const hash = sha256('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('chunkHash', () => {
  it('includes model ID in hash', () => {
    const hash1 = chunkHash('content', 'model-a');
    const hash2 = chunkHash('content', 'model-b');
    expect(hash1).not.toBe(hash2);
  });

  it('same content + model = same hash', () => {
    const hash1 = chunkHash('content', 'model-a');
    const hash2 = chunkHash('content', 'model-a');
    expect(hash1).toBe(hash2);
  });
});
