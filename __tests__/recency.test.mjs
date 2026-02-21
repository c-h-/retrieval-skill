import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractContentTimestamp } from '../src/chunker.mjs';
import { recencyBoost, relativeAge } from '../src/search.mjs';

// ── extractContentTimestamp ──────────────────────────────────────────

describe('extractContentTimestamp', () => {
  it('picks last_edited_time (Notion) over other fields', () => {
    const fm = {
      last_edited_time: '2024-06-15T10:00:00.000Z',
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    expect(extractContentTimestamp(fm)).toBe(new Date('2024-06-15T10:00:00.000Z').getTime());
  });

  it('picks updatedAt (Linear)', () => {
    const fm = { updatedAt: '2025-01-20T08:30:00Z' };
    expect(extractContentTimestamp(fm)).toBe(new Date('2025-01-20T08:30:00Z').getTime());
  });

  it('picks updated_at (snake_case variant)', () => {
    const fm = { updated_at: '2025-03-01' };
    const result = extractContentTimestamp(fm);
    expect(result).toBe(new Date('2025-03-01').getTime());
  });

  it('picks createdAt when no update field present', () => {
    const fm = { createdAt: '2024-12-01T00:00:00Z' };
    expect(extractContentTimestamp(fm)).toBe(new Date('2024-12-01T00:00:00Z').getTime());
  });

  it('picks date field', () => {
    const fm = { date: '2024-08-15' };
    expect(extractContentTimestamp(fm)).toBe(new Date('2024-08-15').getTime());
  });

  it('picks last-reviewed (Mono)', () => {
    const fm = { 'last-reviewed': '2025-02-01' };
    expect(extractContentTimestamp(fm)).toBe(new Date('2025-02-01').getTime());
  });

  it('falls back to mtimeMs when no frontmatter date', () => {
    const fm = { title: 'No timestamps here' };
    expect(extractContentTimestamp(fm, 1700000000000)).toBe(1700000000000);
  });

  it('falls back to mtimeMs when frontmatter is null', () => {
    expect(extractContentTimestamp(null, 1700000000000)).toBe(1700000000000);
  });

  it('returns null when no frontmatter and no mtime', () => {
    expect(extractContentTimestamp(null)).toBeNull();
    expect(extractContentTimestamp(null, null)).toBeNull();
  });

  it('handles epoch-second numeric timestamps', () => {
    const fm = { date: 1700000000 }; // seconds
    expect(extractContentTimestamp(fm)).toBe(1700000000000);
  });

  it('handles epoch-ms numeric timestamps', () => {
    const fm = { date: 1700000000000 }; // ms
    expect(extractContentTimestamp(fm)).toBe(1700000000000);
  });

  it('skips invalid date strings and falls back', () => {
    const fm = { last_edited_time: 'not-a-date', createdAt: '2025-01-01T00:00:00Z' };
    expect(extractContentTimestamp(fm)).toBe(new Date('2025-01-01T00:00:00Z').getTime());
  });

  it('respects priority order: last_edited_time > updatedAt', () => {
    const fm = {
      updatedAt: '2025-06-01T00:00:00Z',
      last_edited_time: '2025-07-01T00:00:00Z',
    };
    expect(extractContentTimestamp(fm)).toBe(new Date('2025-07-01T00:00:00Z').getTime());
  });

  it('floors mtimeMs to integer', () => {
    expect(extractContentTimestamp(null, 1700000000123.456)).toBe(1700000000123);
  });
});

// ── recencyBoost ─────────────────────────────────────────────────────

describe('recencyBoost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 1.0 for null timestamp', () => {
    expect(recencyBoost(null)).toBe(1.0);
    expect(recencyBoost(undefined)).toBe(1.0);
  });

  it('returns 1.0 for content from right now', () => {
    expect(recencyBoost(Date.now())).toBe(1.0);
  });

  it('returns ~0.5 at half-life age', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const halfLife = 90;
    const ts = now - halfLife * 86_400_000;
    const boost = recencyBoost(ts, halfLife);
    expect(boost).toBeCloseTo(0.5, 2);
  });

  it('returns ~0.333 at 2x half-life', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const halfLife = 90;
    const ts = now - 2 * halfLife * 86_400_000;
    const boost = recencyBoost(ts, halfLife);
    expect(boost).toBeCloseTo(1 / 3, 2);
  });

  it('returns higher value for newer content', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const recent = now - 7 * 86_400_000; // 7 days
    const old = now - 365 * 86_400_000; // 1 year
    expect(recencyBoost(recent, 90)).toBeGreaterThan(recencyBoost(old, 90));
  });

  it('applies the scoring formula correctly', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const semanticScore = 0.8;
    const recencyWeight = 0.15;
    const ts = now - 90 * 86_400_000; // half-life age
    const boost = recencyBoost(ts, 90);
    const finalScore = semanticScore * (1 - recencyWeight + recencyWeight * boost);
    // boost ≈ 0.5, so factor = 1 - 0.15 + 0.15 * 0.5 = 0.925
    expect(finalScore).toBeCloseTo(0.8 * 0.925, 3);
  });

  it('returns 1.0 for future timestamps', () => {
    const future = Date.now() + 86_400_000;
    expect(recencyBoost(future)).toBe(1.0);
  });
});

// ── relativeAge ──────────────────────────────────────────────────────

describe('relativeAge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for null/undefined', () => {
    expect(relativeAge(null)).toBeNull();
    expect(relativeAge(undefined)).toBeNull();
  });

  it('returns "today" for same-day timestamp', () => {
    expect(relativeAge(Date.now() - 3600_000)).toBe('today');
  });

  it('returns "1d ago" for yesterday', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(relativeAge(now - 86_400_000)).toBe('1d ago');
  });

  it('returns days for < 30 days', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(relativeAge(now - 15 * 86_400_000)).toBe('15d ago');
  });

  it('returns months for 30-365 days', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(relativeAge(now - 90 * 86_400_000)).toBe('3mo ago');
  });

  it('returns years for > 365 days', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(relativeAge(now - 400 * 86_400_000)).toBe('1y ago');
  });
});
