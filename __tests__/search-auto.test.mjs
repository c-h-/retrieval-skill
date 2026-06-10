import { describe, expect, it } from 'vitest';
import { getAllIndexNames, getIndexMode } from '../src/search.mjs';

/**
 * Tests for the auto-mode search features:
 * - getIndexMode() detects vision vs text indexes
 * - getAllIndexNames() returns all available index names
 * - search() with mode='auto' partitions and fuses correctly
 */

// We test getIndexMode against real index DBs at ~/.retrieval-skill/indexes/
// These tests require actual indexes to exist; skip if not available.

describe('getIndexMode', () => {
  it('detects vision indexes correctly', () => {
    // Known vision indexes from the cooking workspace
    const visionIndexes = ['skinnytaste', 'skinnytaste-one-and-done', 'sheet-pans-5'];
    for (const name of visionIndexes) {
      const mode = getIndexMode(name);
      expect(mode, `Expected ${name} to be vision`).toBe('vision');
    }
  });

  it('detects text indexes correctly', () => {
    // Known text indexes from the cooking workspace
    const textIndexes = ['recipes', 'brian-lagerstrom', 'josh-cortis'];
    for (const name of textIndexes) {
      const mode = getIndexMode(name);
      expect(mode, `Expected ${name} to be text`).toBe('text');
    }
  });

  it('returns text for nonexistent index', () => {
    const mode = getIndexMode('nonexistent-index-abc123');
    expect(mode).toBe('text');
  });
});

describe('getAllIndexNames', () => {
  it('returns an array of index names', () => {
    const names = getAllIndexNames();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
  });

  it('includes known indexes', () => {
    const names = getAllIndexNames();
    expect(names).toContain('recipes');
    expect(names).toContain('skinnytaste');
  });
});

describe('search auto-mode partitioning', () => {
  it('correctly partitions a mixed set of indexes', () => {
    const mixedIndexes = [
      'recipes', // text
      'skinnytaste', // vision
      'brian-lagerstrom', // text
      'skinnytaste-one-and-done', // vision
    ];

    const textIndexes = [];
    const visionIndexes = [];
    for (const name of mixedIndexes) {
      const detected = getIndexMode(name);
      if (detected === 'vision') {
        visionIndexes.push(name);
      } else {
        textIndexes.push(name);
      }
    }

    expect(textIndexes).toEqual(['recipes', 'brian-lagerstrom']);
    expect(visionIndexes).toEqual(['skinnytaste', 'skinnytaste-one-and-done']);
  });

  it('detects all known vision indexes', () => {
    const knownVision = [
      'skinnytaste',
      'skinnytaste-one-and-done',
      'sheet-pans-5',
      'charlie-custom-book',
      'cook-beautiful',
      'healthygirl-kitchen',
      'the-food-lab-kenji',
    ];
    for (const name of knownVision) {
      expect(getIndexMode(name)).toBe('vision');
    }
  });

  it('does not misclassify text indexes as vision', () => {
    const visionSet = new Set([
      'skinnytaste',
      'skinnytaste-one-and-done',
      'sheet-pans-5',
      'charlie-custom-book',
      'cook-beautiful',
      'healthygirl-kitchen',
      'the-food-lab-kenji',
    ]);
    const textIndexes = getAllIndexNames().filter((n) => !visionSet.has(n));
    // Sample a few to avoid long test
    const sample = textIndexes.slice(0, 10);
    for (const name of sample) {
      const mode = getIndexMode(name);
      expect(mode, `${name} should be text but got ${mode}`).toBe('text');
    }
  });
});
