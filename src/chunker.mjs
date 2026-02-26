import { parse as parseYaml } from 'yaml';

export const MIN_CHUNK_CHARS = 80; // skip chunks shorter than this after trimming
export const TARGET_CHUNK_CHARS = 1500; // ~375 tokens at ~4 chars/token, leaves room for context prefix
export const MAX_CHUNK_CHARS = 2000; // hard max
const OVERLAP_CHARS = 200; // overlap for oversized section splits

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter: object|null, body: string }.
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };
  try {
    const frontmatter = parseYaml(match[1]);
    return { frontmatter, body: match[2] };
  } catch {
    return { frontmatter: null, body: content };
  }
}

/**
 * Extract a document title from frontmatter or first heading.
 */
export function extractTitle(frontmatter, body) {
  if (frontmatter) {
    if (frontmatter.title) return frontmatter.title;
    if (frontmatter.name) return frontmatter.name;
    if (frontmatter.subject) return frontmatter.subject;
    if (frontmatter.identifier && frontmatter.title !== undefined) {
      return `${frontmatter.identifier}: ${frontmatter.title}`;
    }
    if (frontmatter.identifier) return frontmatter.identifier;
  }
  // Fall back to first heading
  const headingMatch = body.match(/^#\s+(.+)$/m);
  return headingMatch ? headingMatch[1].trim() : null;
}

/**
 * Split markdown body into sections based on headers.
 * Returns array of { heading: string|null, content: string }.
 */
export function splitSections(body) {
  const lines = body.split('\n');
  const sections = [];
  let currentHeading = null;
  let currentLines = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      // Save previous section if non-empty
      const text = currentLines.join('\n').trim();
      if (text) {
        sections.push({ heading: currentHeading, content: text });
      }
      currentHeading = headingMatch[2].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Final section
  const text = currentLines.join('\n').trim();
  if (text) {
    sections.push({ heading: currentHeading, content: text });
  }

  return sections;
}

/**
 * Split a section's content into paragraph-based chunks.
 * Merges small paragraphs up to TARGET_CHUNK_CHARS.
 * Splits oversized paragraphs at sentence boundaries.
 */
export function splitParagraphs(text) {
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length > MAX_CHUNK_CHARS) {
      // Flush current
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }
      // Split oversized paragraph at sentence boundaries
      const sentences = splitSentences(para);
      let sentBuf = '';
      for (const sent of sentences) {
        if (sentBuf.length + sent.length > TARGET_CHUNK_CHARS && sentBuf.trim()) {
          chunks.push(sentBuf.trim());
          // Overlap: keep last portion
          sentBuf = sentBuf.slice(-OVERLAP_CHARS) + sent;
        } else {
          sentBuf += (sentBuf ? ' ' : '') + sent;
        }
      }
      if (sentBuf.trim()) {
        chunks.push(sentBuf.trim());
      }
    } else if (current.length + para.length + 2 > TARGET_CHUNK_CHARS) {
      // Current chunk is full, flush it
      if (current.trim()) {
        chunks.push(current.trim());
      }
      current = para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Split text into sentences (simple heuristic).
 */
function splitSentences(text) {
  // Split on sentence-ending punctuation followed by space or end
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
}

/**
 * Main chunking function.
 * Takes raw markdown content, returns array of chunks with context.
 * Each chunk: { content: string, sectionContext: string|null }
 */
export function chunkDocument(rawContent) {
  const { frontmatter, body } = parseFrontmatter(rawContent);
  const title = extractTitle(frontmatter, body);
  const sections = splitSections(body);

  if (sections.length === 0) {
    // Document has no content after frontmatter
    return [];
  }

  const chunks = [];

  for (const section of sections) {
    const contextParts = [title, section.heading].filter(Boolean);
    const sectionContext = contextParts.length > 0 ? contextParts.join(' § ') : null;

    const paragraphChunks = splitParagraphs(section.content);

    for (const chunkText of paragraphChunks) {
      if (chunkText.trim().length < MIN_CHUNK_CHARS) continue;

      // Prepend context prefix to chunk content for better retrieval
      const prefix = sectionContext ? `[${sectionContext}] ` : '';
      chunks.push({
        content: prefix + chunkText,
        sectionContext,
      });
    }
  }

  return chunks;
}

/**
 * Priority-ordered frontmatter fields for content timestamps.
 */
const TIMESTAMP_FIELDS = [
  'last_edited_time',
  'updatedAt',
  'updated_at',
  'last_edited',
  'createdAt',
  'created_at',
  'created_time',
  'date',
  'last-reviewed',
];

/**
 * Extract the best content timestamp from frontmatter or fall back to file mtime.
 * Returns epoch milliseconds or null.
 *
 * @param {object|null} frontmatter
 * @param {number|null} mtimeMs - file modification time in ms
 * @returns {number|null}
 */
export function extractContentTimestamp(frontmatter, mtimeMs = null) {
  if (frontmatter) {
    for (const field of TIMESTAMP_FIELDS) {
      const val = frontmatter[field];
      if (val == null) continue;
      const ms = parseTimestamp(val);
      if (ms !== null) return ms;
    }
  }
  return mtimeMs != null ? Math.floor(mtimeMs) : null;
}

/**
 * Parse a timestamp value (ISO string, date string, or epoch number) to ms.
 * Returns number or null on failure.
 */
function parseTimestamp(val) {
  if (typeof val === 'number') {
    // Already epoch ms (or seconds — heuristic: if < 1e12, treat as seconds)
    return val < 1e12 ? val * 1000 : val;
  }
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

/**
 * Extract metadata JSON from frontmatter for storage.
 */
export function extractMetadata(frontmatter) {
  if (!frontmatter) return null;
  return JSON.stringify(frontmatter);
}
