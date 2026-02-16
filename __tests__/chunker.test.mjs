import { describe, it, expect } from 'vitest';
import { parseFrontmatter, extractTitle, splitSections, chunkDocument } from '../src/chunker.mjs';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf-8');

describe('parseFrontmatter', () => {
  it('extracts YAML frontmatter from markdown', () => {
    const content = fixture('sample-issue.md');
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toBeTruthy();
    expect(frontmatter.identifier).toBe('ENG-1234');
    expect(frontmatter.title).toBe('Fix auth token refresh in middleware');
    expect(frontmatter.team).toBe('Engineering');
    expect(body).toContain('# ENG-1234');
  });

  it('handles content without frontmatter', () => {
    const content = fixture('no-frontmatter.md');
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).toBeNull();
    expect(body).toContain('# Simple Document');
  });

  it('handles empty content', () => {
    const { frontmatter, body } = parseFrontmatter('');
    expect(frontmatter).toBeNull();
    expect(body).toBe('');
  });
});

describe('extractTitle', () => {
  it('extracts title from frontmatter', () => {
    const title = extractTitle({ title: 'My Title' }, '# Heading');
    expect(title).toBe('My Title');
  });

  it('extracts subject as title', () => {
    const title = extractTitle({ subject: 'Email Subject' }, '');
    expect(title).toBe('Email Subject');
  });

  it('falls back to first heading', () => {
    const title = extractTitle(null, '# First Heading\n\nSome content');
    expect(title).toBe('First Heading');
  });

  it('returns null for no title info', () => {
    const title = extractTitle(null, 'No headings here');
    expect(title).toBeNull();
  });
});

describe('splitSections', () => {
  it('splits on markdown headers', () => {
    const sections = splitSections('# Title\n\nIntro text\n\n## Section 1\n\nContent 1\n\n## Section 2\n\nContent 2');
    expect(sections.length).toBe(3);
    // First section has heading "Title" from # Title
    expect(sections[0].heading).toBe('Title');
    expect(sections[0].content).toContain('Intro text');
    expect(sections[1].heading).toBe('Section 1');
    expect(sections[2].heading).toBe('Section 2');
  });

  it('handles content with no headers', () => {
    const sections = splitSections('Just plain text\n\nAnother paragraph');
    expect(sections.length).toBe(1);
    expect(sections[0].heading).toBeNull();
  });
});

describe('chunkDocument', () => {
  it('chunks a document with frontmatter', () => {
    const content = fixture('sample-issue.md');
    const chunks = chunkDocument(content);
    expect(chunks.length).toBeGreaterThan(0);
    // Should have context from title
    expect(chunks[0].sectionContext).toContain('Fix auth token refresh');
  });

  it('chunks a document without frontmatter', () => {
    const content = fixture('no-frontmatter.md');
    const chunks = chunkDocument(content);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].sectionContext).toContain('Simple Document');
  });

  it('chunks a slack thread', () => {
    const content = fixture('sample-thread.md');
    const chunks = chunkDocument(content);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('returns empty for empty document', () => {
    const chunks = chunkDocument('---\ntitle: Empty\n---\n');
    expect(chunks.length).toBe(0);
  });

  it('preserves section context in chunks', () => {
    const content = fixture('sample-issue.md');
    const chunks = chunkDocument(content);
    // Comments section splits into individual ### headings (Charlie, Sarah)
    const charlieChunk = chunks.find(c => c.sectionContext && c.sectionContext.includes('Charlie'));
    expect(charlieChunk).toBeTruthy();
    // All chunks should include the document title
    expect(chunks[0].sectionContext).toContain('Fix auth token refresh');
  });
});
