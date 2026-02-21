import { describe, expect, it } from 'vitest';
import { matchesFilters } from '../src/search.mjs';

describe('matchesFilters', () => {
  it('returns true when no filters are provided', () => {
    expect(matchesFilters(null, null)).toBe(true);
    expect(matchesFilters(null, {})).toBe(true);
    expect(matchesFilters('{"source":"slack"}', null)).toBe(true);
    expect(matchesFilters('{"source":"slack"}', {})).toBe(true);
  });

  it('returns false when metadata is null and filters are provided', () => {
    expect(matchesFilters(null, { source: 'slack' })).toBe(false);
  });

  it('returns false when metadata is invalid JSON', () => {
    expect(matchesFilters('not json', { source: 'slack' })).toBe(false);
  });

  it('matches a single filter', () => {
    const meta = JSON.stringify({ source: 'slack', team: 'eng' });
    expect(matchesFilters(meta, { source: 'slack' })).toBe(true);
    expect(matchesFilters(meta, { source: 'linear' })).toBe(false);
  });

  it('matches multiple filters (AND semantics)', () => {
    const meta = JSON.stringify({ source: 'slack', team: 'eng', status: 'open' });
    expect(matchesFilters(meta, { source: 'slack', team: 'eng' })).toBe(true);
    expect(matchesFilters(meta, { source: 'slack', team: 'design' })).toBe(false);
  });

  it('matches case-insensitively', () => {
    const meta = JSON.stringify({ status: 'Open', priority: 'HIGH' });
    expect(matchesFilters(meta, { status: 'open' })).toBe(true);
    expect(matchesFilters(meta, { priority: 'high' })).toBe(true);
  });

  it('returns false when filter key is missing from metadata', () => {
    const meta = JSON.stringify({ source: 'slack' });
    expect(matchesFilters(meta, { team: 'eng' })).toBe(false);
  });

  it('handles numeric values by string comparison', () => {
    const meta = JSON.stringify({ priority: 1 });
    expect(matchesFilters(meta, { priority: '1' })).toBe(true);
    expect(matchesFilters(meta, { priority: '2' })).toBe(false);
  });
});
