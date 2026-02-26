import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from '../src/chunker.mjs';
import {
  chunkGogMessage,
  chunkGogThread,
  detectGogFormat,
  removeQuotedReplies,
  splitThreadMessages,
  stripHtml,
} from '../src/gog-chunker.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf-8');

describe('detectGogFormat', () => {
  it('detects thread format', () => {
    expect(detectGogFormat({ threadId: 'abc', messageCount: 5, subject: 'Test' })).toBe('thread');
  });

  it('detects message format', () => {
    expect(detectGogFormat({ id: 'abc', threadId: 'def', from: 'a@b.com' })).toBe('message');
  });

  it('returns null for non-gog frontmatter', () => {
    expect(detectGogFormat({ title: 'Some doc', team: 'Engineering' })).toBeNull();
  });

  it('returns null for null frontmatter', () => {
    expect(detectGogFormat(null)).toBeNull();
  });

  it('requires messageCount to be a number for thread detection', () => {
    // threadId alone without messageCount → message (if id present) or null
    expect(detectGogFormat({ threadId: 'abc' })).toBeNull();
  });
});

describe('stripHtml', () => {
  it('strips basic HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('converts block tags to newlines', () => {
    const result = stripHtml('<p>First paragraph</p><p>Second paragraph</p>');
    expect(result).toContain('First paragraph');
    expect(result).toContain('Second paragraph');
    expect(result).toContain('\n');
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'');
  });

  it('removes style blocks', () => {
    const result = stripHtml('<style>body { color: red; }</style><p>Visible</p>');
    expect(result).toBe('Visible');
    expect(result).not.toContain('color');
  });

  it('removes script blocks', () => {
    const result = stripHtml('<script>alert("xss")</script><p>Safe</p>');
    expect(result).toBe('Safe');
  });

  it('removes HTML comments', () => {
    const result = stripHtml('<!-- tracking --><p>Content</p>');
    expect(result).toBe('Content');
  });

  it('converts br tags to newlines', () => {
    expect(stripHtml('Line 1<br>Line 2<br/>Line 3')).toBe('Line 1\nLine 2\nLine 3');
  });

  it('decodes numeric character references', () => {
    expect(stripHtml('&#169; &#8212;')).toBe('\u00A9 \u2014');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
    expect(stripHtml(null)).toBe('');
  });

  it('collapses excessive whitespace', () => {
    const result = stripHtml('<p>Hello</p>\n\n\n\n<p>World</p>');
    expect(result).not.toMatch(/\n{3,}/);
  });
});

describe('removeQuotedReplies', () => {
  it('removes > prefixed quoted lines', () => {
    const text = 'My reply here.\n\n> Previous message\n> More quoted text';
    const result = removeQuotedReplies(text);
    expect(result).toBe('My reply here.');
  });

  it('removes text after "On ... wrote:" attribution', () => {
    const text = 'My response.\n\nOn Mon, Jan 1, 2024 at 10:00 AM Alice wrote:\n\nOriginal message text here.';
    const result = removeQuotedReplies(text);
    expect(result).toBe('My response.');
  });

  it('handles mixed > quotes and attribution', () => {
    const text = 'Response.\n\nOn Mon, Jan 1 Alice wrote:\n\n> Quoted text\n> More quoted';
    const result = removeQuotedReplies(text);
    expect(result).toBe('Response.');
  });

  it('preserves text with no quotes', () => {
    const text = 'Just a regular message\nWith multiple lines\nNo quoting here.';
    const result = removeQuotedReplies(text);
    expect(result).toBe(text);
  });

  it('handles empty input', () => {
    expect(removeQuotedReplies('')).toBe('');
  });

  it('strips inline > quotes mid-message', () => {
    const text = 'Before quote.\n> Quoted line\nAfter quote.';
    const result = removeQuotedReplies(text);
    expect(result).toBe('Before quote.\nAfter quote.');
    expect(result).not.toContain('Quoted line');
  });
});

describe('splitThreadMessages', () => {
  it('splits thread body into individual messages', () => {
    const content = fixture('sample-gog-thread.md');
    const { body } = parseFrontmatter(content);
    const messages = splitThreadMessages(body);

    expect(messages).toHaveLength(3);
    expect(messages[0].from).toContain('Alice Smith');
    expect(messages[1].from).toContain('Bob Jones');
    expect(messages[2].from).toContain('Carol White');
  });

  it('extracts message headers correctly', () => {
    const content = fixture('sample-gog-thread.md');
    const { body } = parseFrontmatter(content);
    const messages = splitThreadMessages(body);

    expect(messages[0].subject).toBe('Project Update Meeting');
    expect(messages[0].date).toContain('Mon, 1 Jan 2024');
    expect(messages[1].subject).toBe('Re: Project Update Meeting');
  });

  it('extracts message bodies without headers', () => {
    const content = fixture('sample-gog-thread.md');
    const { body } = parseFrontmatter(content);
    const messages = splitThreadMessages(body);

    // First message body should start with actual content, not headers
    expect(messages[0].body).toContain('Hi team');
    expect(messages[0].body).not.toContain('**From:**');
  });

  it('returns empty array for body with no messages', () => {
    expect(splitThreadMessages('Just some plain text')).toHaveLength(0);
  });
});

describe('chunkGogThread', () => {
  it('produces one chunk per message for small thread', () => {
    const content = fixture('sample-gog-thread.md');
    const chunks = chunkGogThread(content);

    // 3 messages in the fixture
    expect(chunks.length).toBe(3);
  });

  it('includes message metadata in chunk context', () => {
    const content = fixture('sample-gog-thread.md');
    const chunks = chunkGogThread(content);

    // Each chunk should have sender and subject context
    expect(chunks[0].sectionContext).toContain('Alice Smith');
    expect(chunks[0].sectionContext).toContain('Project Update Meeting');
    expect(chunks[1].sectionContext).toContain('Bob Jones');
  });

  it('strips quoted replies from thread messages', () => {
    const content = fixture('sample-gog-thread.md');
    const chunks = chunkGogThread(content);

    // Bob's message should not contain Alice's quoted text
    const bobChunk = chunks[1].content;
    expect(bobChunk).toContain('A few questions');
    expect(bobChunk).not.toContain('I wanted to share an update');

    // Carol's message should not contain quoted text
    const carolChunk = chunks[2].content;
    expect(carolChunk).toContain('test coverage review');
    expect(carolChunk).not.toContain('Do we have enough test coverage');
  });

  it('includes date in chunk context', () => {
    const content = fixture('sample-gog-thread.md');
    const chunks = chunkGogThread(content);

    expect(chunks[0].sectionContext).toContain('Mon, 1 Jan 2024');
  });

  it('returns empty for thread with no parseable messages', () => {
    const content = '---\nthreadId: empty\nmessageCount: 0\nparticipants: []\n---\n\nNo messages here.';
    expect(chunkGogThread(content)).toHaveLength(0);
  });
});

describe('chunkGogMessage', () => {
  it('strips HTML from message body', () => {
    const content = fixture('sample-gog-message-html.md');
    const chunks = chunkGogMessage(content);

    expect(chunks.length).toBeGreaterThan(0);
    // Should contain text content
    expect(chunks[0].content).toContain('Weekly Report');
    expect(chunks[0].content).toContain('Tasks completed: 15');
    // Should not contain HTML
    expect(chunks[0].content).not.toContain('<p>');
    expect(chunks[0].content).not.toContain('<div');
    expect(chunks[0].content).not.toContain('font-family');
  });

  it('preserves message metadata in context', () => {
    const content = fixture('sample-gog-message-html.md');
    const chunks = chunkGogMessage(content);

    expect(chunks[0].sectionContext).toContain('Your Weekly Report');
    expect(chunks[0].sectionContext).toContain('Notifications');
  });

  it('removes quoted replies from message', () => {
    const content = fixture('sample-gog-message-reply.md');
    const chunks = chunkGogMessage(content);

    expect(chunks.length).toBeGreaterThan(0);
    // Should contain original reply content
    expect(chunks[0].content).toContain('budget proposal');
    expect(chunks[0].content).toContain('engineering budget by 15%');
    // Should NOT contain quoted text from Jane
    expect(chunks[0].content).not.toContain('Please review the attached');
  });

  it('returns empty for tiny messages', () => {
    const content = '---\nid: tiny\nthreadId: t\nfrom: a@b.com\ndate: Mon, 1 Jan 2024\nsubject: Hi\n---\n\nOk.';
    expect(chunkGogMessage(content)).toHaveLength(0);
  });

  it('splits large messages into multiple chunks', () => {
    // Create a message with a very long body
    const longBody = Array.from(
      { length: 50 },
      (_, i) =>
        `Paragraph ${i + 1}: This is a detailed discussion about topic ${i + 1} that contains enough text to be meaningful for retrieval purposes and semantic search.`,
    ).join('\n\n');
    const content = `---\nid: long\nthreadId: t\nfrom: a@b.com\ndate: Mon, 1 Jan 2024\nsubject: Long Email\n---\n\n${longBody}`;

    const chunks = chunkGogMessage(content);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should have part number in context
    expect(chunks[0].sectionContext).toContain('part 1');
    expect(chunks[1].sectionContext).toContain('part 2');
  });
});

describe('integration: gog detection in chunker pipeline', () => {
  it('detects thread format from real-style frontmatter', () => {
    const content = fixture('sample-gog-thread.md');
    const { frontmatter } = parseFrontmatter(content);
    expect(detectGogFormat(frontmatter)).toBe('thread');
  });

  it('detects message format from real-style frontmatter', () => {
    const content = fixture('sample-gog-message-html.md');
    const { frontmatter } = parseFrontmatter(content);
    expect(detectGogFormat(frontmatter)).toBe('message');
  });

  it('does not detect gog format for slack threads', () => {
    const content = fixture('sample-thread.md');
    const { frontmatter } = parseFrontmatter(content);
    expect(detectGogFormat(frontmatter)).toBeNull();
  });

  it('does not detect gog format for linear issues', () => {
    const content = fixture('sample-issue.md');
    const { frontmatter } = parseFrontmatter(content);
    expect(detectGogFormat(frontmatter)).toBeNull();
  });
});
