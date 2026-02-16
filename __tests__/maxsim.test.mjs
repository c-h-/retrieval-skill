import { describe, it, expect } from 'vitest';
import { maxSimScore } from '../src/search/maxsim.mjs';

describe('maxSimScore', () => {
  it('returns positive score for similar vectors', () => {
    // Query: 2 token vectors of dim 4
    const qVecs = [
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
    ];
    // Page: 3 patch vectors of dim 4
    const pVecs = [
      new Float32Array([0.9, 0.1, 0, 0]),
      new Float32Array([0.1, 0.9, 0, 0]),
      new Float32Array([0, 0, 1, 0]),
    ];

    const score = maxSimScore(qVecs, pVecs);
    // q[0] best matches p[0] (cos ~ 0.99), q[1] best matches p[1] (cos ~ 0.99)
    expect(score).toBeGreaterThan(1.5);
  });

  it('returns low score for orthogonal vectors', () => {
    const qVecs = [
      new Float32Array([1, 0, 0, 0]),
    ];
    const pVecs = [
      new Float32Array([0, 0, 0, 1]),
    ];

    const score = maxSimScore(qVecs, pVecs);
    expect(score).toBeCloseTo(0, 1);
  });

  it('handles identical query and page vectors', () => {
    const vecs = [
      new Float32Array([0.5, 0.5, 0, 0]),
      new Float32Array([0, 0, 0.5, 0.5]),
    ];

    const score = maxSimScore(vecs, vecs);
    // Each query vector matches itself with cos sim = 1
    expect(score).toBeCloseTo(2, 1);
  });

  it('scales with number of query tokens', () => {
    const p = [new Float32Array([1, 0, 0, 0])];

    const q1 = [new Float32Array([1, 0, 0, 0])];
    const q3 = [
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([1, 0, 0, 0]),
    ];

    const s1 = maxSimScore(q1, p);
    const s3 = maxSimScore(q3, p);
    expect(s3).toBeCloseTo(s1 * 3, 5);
  });
});
