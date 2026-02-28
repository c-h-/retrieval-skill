/**
 * MIME parsing utilities for Gmail message payloads.
 *
 * Gmail returns message bodies in the `payload` tree (nested `MessagePart`
 * objects).  This module recursively walks that tree to extract:
 *   - text/plain body
 *   - text/html  body (fallback)
 *   - attachment metadata (binary data is fetched separately via the API)
 *
 * Body data is base64url-encoded by the Gmail API.  We decode it here and
 * handle charset conversion for non-UTF-8 content.
 */

import type { gmail_v1 } from "googleapis";
import TurndownService from "turndown";
import type { AttachmentMeta, MimeWalkResult } from "./types.js";

// ─── Turndown singleton ───

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

// ─── Charset helpers ───

/**
 * Extract the `charset` parameter from a Content-Type MIME type string.
 * Returns the charset name normalised to lowercase, or "utf-8" as default.
 */
function extractCharset(mimeType: string | undefined | null): string {
  if (!mimeType) return "utf-8";
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(mimeType);
  return match ? match[1].toLowerCase() : "utf-8";
}

/**
 * Map legacy charset names to labels recognised by `TextDecoder`.
 */
function normalizeCharsetLabel(charset: string): string {
  const map: Record<string, string> = {
    ascii: "utf-8",
    "us-ascii": "utf-8",
    "windows-1252": "windows-1252",
    cp1252: "windows-1252",
    "iso-8859-1": "windows-1252", // TextDecoder maps iso-8859-1 to windows-1252
    latin1: "windows-1252",
    gb2312: "gbk",
    gb_2312: "gbk",
    shift_jis: "shift_jis",
    "euc-jp": "euc-jp",
    "euc-kr": "euc-kr",
    "iso-2022-jp": "iso-2022-jp",
    big5: "big5",
    "koi8-r": "koi8-r",
  };
  return map[charset] ?? charset;
}

/**
 * Decode a base64url-encoded body string to UTF-8 text, respecting the
 * charset declared in the Content-Type header.
 */
function decodeBody(data: string, contentType?: string | null): string {
  const raw = Buffer.from(data, "base64url");
  const charset = normalizeCharsetLabel(extractCharset(contentType));

  if (charset === "utf-8") {
    return raw.toString("utf-8");
  }

  try {
    const decoder = new TextDecoder(charset);
    return decoder.decode(raw);
  } catch {
    // Fallback: treat as UTF-8 if the charset is unsupported
    return raw.toString("utf-8");
  }
}

// ─── Part walking ───

/**
 * Recursively walk a Gmail message payload tree and extract text bodies and
 * attachment metadata.
 *
 * Handles:
 *   - multipart/alternative  (text/plain + text/html siblings)
 *   - multipart/mixed        (body + attachments)
 *   - multipart/related      (HTML + inline images)
 *   - multipart/signed       (signed content + signature — we extract content)
 *   - Deeply nested combinations of the above
 */
export function walkParts(
  part: gmail_v1.Schema$MessagePart | undefined | null,
): MimeWalkResult {
  let plain = "";
  let html = "";
  const attachments: AttachmentMeta[] = [];

  if (!part) {
    return { plain, html, attachments };
  }

  const mime = (part.mimeType ?? "").toLowerCase();

  // Leaf: text/plain body
  if (mime === "text/plain" && part.body?.data && !part.filename) {
    const contentType = part.headers?.find(
      (h) => h.name?.toLowerCase() === "content-type",
    )?.value;
    plain += decodeBody(part.body.data, contentType ?? part.mimeType);
  }
  // Leaf: text/html body
  else if (mime === "text/html" && part.body?.data && !part.filename) {
    const contentType = part.headers?.find(
      (h) => h.name?.toLowerCase() === "content-type",
    )?.value;
    html += decodeBody(part.body.data, contentType ?? part.mimeType);
  }
  // Leaf: attachment or inline file
  else if (part.filename && part.body?.attachmentId) {
    const contentId = part.headers
      ?.find((h) => h.name?.toLowerCase() === "content-id")
      ?.value?.replace(/[<>]/g, "");

    attachments.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body.size ?? 0,
      contentId: contentId || undefined,
    });
  }

  // Recurse into child parts (multipart/*)
  if (part.parts) {
    for (const sub of part.parts) {
      const result = walkParts(sub);
      plain += result.plain;
      html += result.html;
      attachments.push(...result.attachments);
    }
  }

  return { plain, html, attachments };
}

// ─── Header extraction helper ───

/**
 * Build a case-insensitive header lookup from a Gmail payload's headers array.
 */
export function getHeader(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined | null,
  name: string,
): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  return headers.find((h) => h.name?.toLowerCase() === lower)?.value ?? "";
}

// ─── Full message parser ───

import type { GmailMessage } from "./types.js";

/**
 * Parse a raw Gmail API `Schema$Message` (fetched with `format=full`) into
 * our domain `GmailMessage` type.
 */
export function parseMessage(msg: gmail_v1.Schema$Message): GmailMessage {
  const headers = msg.payload?.headers;
  const { plain, html, attachments } = walkParts(msg.payload);

  return {
    id: msg.id!,
    threadId: msg.threadId!,
    labelIds: msg.labelIds ?? [],
    historyId: msg.historyId!,
    internalDate: parseInt(msg.internalDate ?? "0", 10),
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc") || undefined,
    bcc: getHeader(headers, "Bcc") || undefined,
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    messageId: getHeader(headers, "Message-ID"),
    inReplyTo: getHeader(headers, "In-Reply-To") || undefined,
    references: getHeader(headers, "References") || undefined,
    bodyPlain: plain || undefined,
    bodyHtml: html || undefined,
    snippet: msg.snippet ?? "",
    attachments,
    sizeEstimate: msg.sizeEstimate ?? 0,
  };
}

// ─── Body to markdown ───

/**
 * Convert a parsed message's body to markdown.
 *
 * Priority:
 *   1. text/plain  (already markdown-ish)
 *   2. text/html   (converted via turndown)
 *   3. Gmail snippet (last resort)
 */
export function bodyToMarkdown(msg: GmailMessage): string {
  if (msg.bodyPlain) {
    return msg.bodyPlain;
  }
  if (msg.bodyHtml) {
    return turndown.turndown(msg.bodyHtml);
  }
  return msg.snippet;
}
