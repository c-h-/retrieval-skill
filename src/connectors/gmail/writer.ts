/**
 * Output writer for Gmail adapter.
 *
 * Translates parsed `GmailMessage` objects into the on-disk format:
 *
 *   messages/{msgId}.md          – Markdown with YAML frontmatter
 *   messages/{msgId}.meta.json   – Full metadata sidecar
 *   attachments/{msgId}/{file}   – Binary attachment files
 *   threads/{threadId}.md        – Thread rollup view
 *   _labels.json                 – Label id→name mapping
 */

import type { Logger, OutputWriter } from "../core/index.js";
import { sanitizeFilename } from "../core/index.js";
import { bodyToMarkdown } from "./mime.js";
import type { GmailLabel, GmailMessage } from "./types.js";

// ─── Label helpers ───

/**
 * Resolve an array of label IDs to human-readable names using a label map.
 */
export function resolveLabels(
  labelIds: string[],
  labelMap: Map<string, GmailLabel>,
): string[] {
  return labelIds.map((id) => labelMap.get(id)?.name ?? id);
}

// ─── Message writing ───

/**
 * Write a single message to disk as markdown + metadata sidecar.
 */
export async function writeMessage(
  writer: OutputWriter,
  msg: GmailMessage,
  labelMap: Map<string, GmailLabel>,
): Promise<void> {
  const labels = resolveLabels(msg.labelIds, labelMap);
  const body = bodyToMarkdown(msg);

  // ── Markdown file with YAML frontmatter ──

  const frontmatter: Record<string, unknown> = {
    id: msg.id,
    thread_id: msg.threadId,
    date: msg.date,
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    labels,
  };
  if (msg.cc) frontmatter.cc = msg.cc;
  if (msg.bcc) frontmatter.bcc = msg.bcc;

  // Build attachment links section
  let attachmentSection = "";
  if (msg.attachments.length > 0) {
    const lines = msg.attachments.map((a) => {
      const sizeKb = (a.size / 1024).toFixed(1);
      const safeName = sanitizeFilename(a.filename);
      return `- [${a.filename}](../attachments/${msg.id}/${safeName}) (${sizeKb} KB)`;
    });
    attachmentSection = `\n\nAttachments:\n${lines.join("\n")}`;
  }

  await writer.writeDocument(
    `messages/${msg.id}.md`,
    frontmatter,
    body + attachmentSection,
  );

  // ── Metadata sidecar JSON ──

  const meta: Record<string, unknown> = {
    id: msg.id,
    threadId: msg.threadId,
    historyId: msg.historyId,
    internalDate: msg.internalDate,
    from: msg.from,
    to: msg.to,
    subject: msg.subject,
    messageId: msg.messageId,
    labelIds: msg.labelIds,
    labels,
    sizeEstimate: msg.sizeEstimate,
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
    syncedAt: new Date().toISOString(),
  };
  if (msg.cc) meta.cc = msg.cc;
  if (msg.bcc) meta.bcc = msg.bcc;
  if (msg.inReplyTo) meta.inReplyTo = msg.inReplyTo;
  if (msg.references) meta.references = msg.references;

  await writer.writeMeta(`messages/${msg.id}.meta.json`, meta);
}

// ─── Attachment writing ───

export interface AttachmentWriteResult {
  written: number;
  skipped: AttachmentSkip[];
}

export interface AttachmentSkip {
  filename: string;
  size: number;
  reason: string;
}

/**
 * Write all attachments for a single message.
 *
 * Fetches attachment data via the provided `fetchFn` and writes them to
 * `attachments/{msgId}/{sanitizedFilename}`.
 *
 * Attachments exceeding `maxBytes` are skipped and reported.
 */
export async function writeAttachments(
  writer: OutputWriter,
  msg: GmailMessage,
  fetchFn: (messageId: string, attachmentId: string) => Promise<Buffer>,
  maxBytes: number,
  logger: Logger,
): Promise<AttachmentWriteResult> {
  let written = 0;
  const skipped: AttachmentSkip[] = [];

  for (const att of msg.attachments) {
    // Size check before download
    if (att.size > maxBytes) {
      skipped.push({
        filename: att.filename,
        size: att.size,
        reason: "exceeds_max_size",
      });
      logger.warn("Skipping oversized attachment", {
        messageId: msg.id,
        filename: att.filename,
        size: att.size,
        maxBytes,
      });
      continue;
    }

    try {
      const data = await fetchFn(msg.id, att.attachmentId);
      const safeName = sanitizeFilename(att.filename);
      await writer.writeBinary(`attachments/${msg.id}/${safeName}`, data);
      written++;
    } catch (err) {
      skipped.push({
        filename: att.filename,
        size: att.size,
        reason: err instanceof Error ? err.message : String(err),
      });
      logger.warn("Failed to download attachment", {
        messageId: msg.id,
        filename: att.filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { written, skipped };
}

// ─── Thread view generation ───

/**
 * Generate a thread rollup markdown document from a sorted list of messages
 * belonging to the same thread.
 *
 * Messages should be sorted by `internalDate` ascending (oldest first).
 */
export async function writeThreadView(
  writer: OutputWriter,
  threadId: string,
  messages: GmailMessage[],
): Promise<void> {
  if (messages.length === 0) return;

  const subject = messages[0].subject || "(no subject)";
  const parts: string[] = [`# Thread: ${subject}`, ""];

  for (const msg of messages) {
    parts.push(`## ${msg.from} — ${msg.date}`);
    parts.push("");
    parts.push(bodyToMarkdown(msg));
    parts.push("");
    parts.push("---");
    parts.push("");
  }

  // Remove trailing separator
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts[parts.length - 1] === "---") parts.pop();
  if (parts[parts.length - 1] === "") parts.pop();

  await writer.writeDocument(
    `threads/${threadId}.md`,
    { thread_id: threadId, subject, message_count: messages.length },
    parts.join("\n"),
  );
}

// ─── Labels file ───

/**
 * Write the label map as `_labels.json` for downstream consumers.
 */
export async function writeLabels(
  writer: OutputWriter,
  labels: GmailLabel[],
): Promise<void> {
  const data: Record<string, unknown> = {};
  for (const label of labels) {
    data[label.id] = { name: label.name, type: label.type };
  }
  await writer.writeMeta("_labels.json", data);
}

// ─── Delete message artifacts ───

/**
 * Remove all output files for a given message ID (markdown, meta, attachments dir).
 */
export async function removeMessage(
  writer: OutputWriter,
  messageId: string,
): Promise<void> {
  await writer.remove(`messages/${messageId}.md`);
  await writer.remove(`messages/${messageId}.meta.json`);
  // Note: attachment directory removal would require listing — we just remove
  // the known paths.  In practice the output directory structure handles this.
}
