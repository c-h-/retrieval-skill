import { extractTitle, MIN_CHUNK_CHARS, parseFrontmatter, splitParagraphs, TARGET_CHUNK_CHARS } from './chunker.mjs';

/**
 * Detect if content is a gog email thread or single message based on frontmatter.
 * @param {object|null} frontmatter
 * @returns {'thread'|'message'|null}
 */
export function detectGogFormat(frontmatter) {
  if (!frontmatter) return null;
  if (frontmatter.threadId && typeof frontmatter.messageCount === 'number') return 'thread';
  if (frontmatter.id && frontmatter.threadId) return 'message';
  return null;
}

/**
 * Strip HTML tags, decode entities, normalize whitespace.
 * Converts block-level elements to line breaks before removing tags.
 */
export function stripHtml(text) {
  if (!text) return '';
  let r = text;
  // Remove HTML comments
  r = r.replace(/<!--[\s\S]*?-->/g, '');
  // Remove style and script blocks entirely
  r = r.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Convert line-break tags to newlines
  r = r.replace(/<br\s*\/?>/gi, '\n');
  // Convert block-level closing tags to newlines
  r = r.replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote)>/gi, '\n');
  // Strip all remaining HTML tags
  r = r.replace(/<[^>]+>/g, '');
  // Decode HTML entities
  r = r
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&\w+;/g, '');
  // Normalize whitespace
  r = r.replace(/[ \t]+/g, ' ');
  r = r.replace(/\n[ \t]+/g, '\n');
  r = r.replace(/\n{3,}/g, '\n\n');
  return r.trim();
}

/**
 * Check if text appears to contain HTML markup.
 */
function isHtml(text) {
  return /<(!DOCTYPE|html|head|body|div|span|table|a\s|br|img)\b/i.test(text);
}

/**
 * Remove quoted reply content from an email message body.
 * Handles two common patterns:
 * 1. Lines prefixed with ">" (standard email quoting)
 * 2. "On [date], [name] wrote:" attribution — strips from there to end
 */
export function removeQuotedReplies(text) {
  const lines = text.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Skip lines starting with > (inline quoted text)
    if (trimmed.startsWith('>')) continue;

    // "On ... wrote:" marks the start of a quoted reply block.
    // Everything from here to end is the previous message.
    if (/^On .+wrote:\s*$/i.test(trimmed)) break;

    result.push(lines[i]);
  }

  return result.join('\n').trim();
}

/**
 * Parse message headers from a thread message block.
 * Expects bold markdown: **From:**, **Date:**, **Subject:**
 * Returns { from, date, subject, body }.
 */
function parseMessageBlock(text) {
  const from = text.match(/\*\*From:\*\*\s*(.+)/m)?.[1]?.trim() || '';
  const date = text.match(/\*\*Date:\*\*\s*(.+)/m)?.[1]?.trim() || '';
  const subject = text.match(/\*\*Subject:\*\*\s*(.+)/m)?.[1]?.trim() || '';

  // Find body: skip header lines (**Key:** ...) then blank lines
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && /^\*\*\w/.test(lines[i].trim())) i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  const body = lines.slice(i).join('\n').trim();

  return { from, date, subject, body };
}

/**
 * Split a thread body (after frontmatter) into individual messages.
 * Messages are separated by --- followed by **From:** headers.
 * @returns {Array<{from: string, date: string, subject: string, body: string}>}
 */
export function splitThreadMessages(body) {
  // Split on --- separator only when followed by a **From:** header
  const parts = body.split(/\n---\n(?=\*\*From:\*\*)/);
  const messages = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || !/^\*\*From:\*\*/.test(trimmed)) continue;
    messages.push(parseMessageBlock(trimmed));
  }

  return messages;
}

/**
 * Build a context prefix string for a message chunk.
 */
function messageContext(subject, from, date) {
  const parts = [subject, from].filter(Boolean);
  const ctx = parts.join(' § ');
  return date ? `${ctx} @ ${date}` : ctx;
}

/**
 * Create chunks from a single email message body.
 * Strips HTML and quoted replies, then splits into sized chunks.
 */
function chunkMessageBody(body, subject, from, date) {
  let clean = isHtml(body) ? stripHtml(body) : body;
  clean = removeQuotedReplies(clean);

  if (clean.length < MIN_CHUNK_CHARS) return [];

  const ctx = messageContext(subject, from, date);
  const chunks = [];

  if (clean.length <= TARGET_CHUNK_CHARS) {
    chunks.push({ content: `[${ctx}]\n${clean}`, sectionContext: ctx });
  } else {
    const parts = splitParagraphs(clean);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].trim().length < MIN_CHUNK_CHARS) continue;
      const partCtx = parts.length > 1 ? `${ctx} (part ${i + 1})` : ctx;
      chunks.push({ content: `[${partCtx}]\n${parts[i]}`, sectionContext: partCtx });
    }
  }

  return chunks;
}

/**
 * Chunk a gog email thread file.
 * Splits the thread into individual messages and chunks each one separately.
 * Quoted reply chains are removed so each chunk contains only unique content.
 */
export function chunkGogThread(rawContent) {
  const { frontmatter, body } = parseFrontmatter(rawContent);
  const threadSubject = frontmatter?.subject || extractTitle(frontmatter, body) || '';
  const messages = splitThreadMessages(body);
  const allChunks = [];

  for (const msg of messages) {
    const subject = msg.subject || threadSubject;
    allChunks.push(...chunkMessageBody(msg.body, subject, msg.from, msg.date));
  }

  return allChunks;
}

/**
 * Chunk a single gog email message file.
 * Strips HTML, removes quoted replies, preserves headers as context metadata.
 */
export function chunkGogMessage(rawContent) {
  const { frontmatter, body } = parseFrontmatter(rawContent);
  const subject = frontmatter?.subject || '';
  const from = frontmatter?.from || '';
  const date = frontmatter?.date || '';

  return chunkMessageBody(body, subject, from, date);
}
