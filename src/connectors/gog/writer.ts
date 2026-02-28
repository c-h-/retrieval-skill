/**
 * Output file writers for the GOG adapter.
 *
 * Writes messages as markdown with YAML frontmatter,
 * plus JSON metadata and attachment files.
 */

import type { OutputWriter } from "../core/index.js";
import type { GogLabel, GogMessageFull } from "./types.js";

export async function writeMessage(
  writer: OutputWriter,
  msg: GogMessageFull,
  labelMap: Map<string, string>,
): Promise<void> {
  const id = msg.message.id;
  const h = msg.headers;

  // Frontmatter
  const labelNames = (msg.message.labelIds ?? []).map(
    (lid) => labelMap.get(lid) ?? lid,
  );

  const fm: Record<string, unknown> = {
    id,
    threadId: msg.message.threadId,
    from: h.from,
    to: h.to,
    cc: h.cc || undefined,
    bcc: h.bcc || undefined,
    date: h.date,
    subject: h.subject,
    labels: labelNames,
    sizeEstimate: msg.message.sizeEstimate,
    historyId: msg.message.historyId,
  };

  // Clean undefined values
  for (const key of Object.keys(fm)) {
    if (fm[key] === undefined || fm[key] === "") delete fm[key];
  }

  const body = msg.body || "(no body)";

  await writer.writeDocument(`messages/${id}.md`, fm, body);
  await writer.writeMeta(`messages/${id}.meta.json`, {
    ...fm,
    snippet: msg.message.snippet,
    internalDate: msg.message.internalDate,
    payload: {
      mimeType: msg.message.payload.mimeType,
    },
  });
}

export async function writeLabels(
  writer: OutputWriter,
  labels: GogLabel[],
): Promise<void> {
  await writer.writeMeta("_meta/labels.json", { labels });
}

export async function removeMessage(
  writer: OutputWriter,
  messageId: string,
): Promise<void> {
  try {
    await writer.remove(`messages/${messageId}.md`);
    await writer.remove(`messages/${messageId}.meta.json`);
  } catch {
    // File may not exist, that's fine
  }
}

/** Build a thread markdown view from a list of messages belonging to the same thread. */
export async function writeThreadView(
  writer: OutputWriter,
  threadId: string,
  messages: GogMessageFull[],
  _labelMap: Map<string, string>,
): Promise<void> {
  if (messages.length === 0) return;

  // Sort by internalDate
  const sorted = [...messages].sort(
    (a, b) =>
      parseInt(a.message.internalDate, 10) -
      parseInt(b.message.internalDate, 10),
  );

  const subject = sorted[0]?.headers.subject || "(no subject)";

  const fm: Record<string, unknown> = {
    threadId,
    subject,
    messageCount: sorted.length,
    participants: [
      ...new Set(sorted.map((m) => m.headers.from).filter(Boolean)),
    ],
  };

  const parts = sorted.map((m) => {
    const divider = `---\n**From:** ${m.headers.from}  \n**Date:** ${m.headers.date}  \n**Subject:** ${m.headers.subject}\n\n`;
    return divider + (m.body || "(no body)");
  });

  await writer.writeDocument(`threads/${threadId}.md`, fm, parts.join("\n\n"));
}
