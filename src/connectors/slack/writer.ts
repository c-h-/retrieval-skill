/**
 * Output file writers for Slack adapter.
 *
 * Produces:
 * - channels/{slug}/messages.md   (YAML frontmatter + date-grouped messages)
 * - channels/{slug}/messages.jsonl (machine-readable, one message per line)
 * - channels/{slug}/_meta.json    (channel metadata sidecar)
 * - threads/{channel-slug}/{thread_ts}.md (self-contained thread documents)
 */

import type { OutputWriter } from "../core/index.js";
import {
  formatDate,
  formatTime,
  formatTimestamp,
  getAuthorName,
  getDateGroup,
  isSystemMessage,
  renderMessageText,
} from "./transform.js";
import type {
  ChannelExportData,
  ChannelMap,
  JsonlRecord,
  SlackChannel,
  SlackMessage,
  SlackReaction,
  UserMap,
} from "./types.js";

// ─── Channel Messages Writer ───

/**
 * Write all output files for a single channel: messages.md, messages.jsonl, _meta.json,
 * and thread documents.
 */
export async function writeChannelOutput(
  writer: OutputWriter,
  data: ChannelExportData,
  channelMap: ChannelMap,
): Promise<void> {
  const { channel, slug, messages, threads, userMap } = data;
  const basePath = `channels/${slug}`;

  // Write messages.md
  await writeMessagesMd(
    writer,
    basePath,
    channel,
    messages,
    threads,
    userMap,
    channelMap,
  );

  // Write messages.jsonl
  await writeMessagesJsonl(writer, basePath, messages, userMap, channelMap);

  // Write _meta.json
  await writeChannelMeta(writer, basePath, channel, messages);

  // Write thread documents
  await writeThreadDocuments(
    writer,
    slug,
    channel,
    threads,
    userMap,
    channelMap,
  );
}

/**
 * Append new messages to an existing channel during incremental sync.
 */
export async function appendChannelOutput(
  writer: OutputWriter,
  data: ChannelExportData,
  channelMap: ChannelMap,
): Promise<void> {
  const { channel, slug, messages, threads, userMap } = data;
  const basePath = `channels/${slug}`;

  if (messages.length > 0) {
    // For incremental, we rewrite messages.md with all messages (caller provides full set)
    // and append to jsonl
    await writeMessagesMd(
      writer,
      basePath,
      channel,
      messages,
      threads,
      userMap,
      channelMap,
    );

    const jsonlRecords = messages.map((msg) =>
      buildJsonlRecord(msg, userMap, channelMap),
    );
    await writer.appendJsonl(
      `${basePath}/messages.jsonl`,
      jsonlRecords as unknown as Record<string, unknown>[],
    );

    // Update meta
    await writeChannelMeta(writer, basePath, channel, messages);
  }

  // Write/update thread documents
  await writeThreadDocuments(
    writer,
    slug,
    channel,
    threads,
    userMap,
    channelMap,
  );
}

// ─── Messages Markdown ───

async function writeMessagesMd(
  writer: OutputWriter,
  basePath: string,
  channel: SlackChannel,
  messages: SlackMessage[],
  threads: Map<string, SlackMessage[]>,
  userMap: UserMap,
  channelMap: ChannelMap,
): Promise<void> {
  const frontmatter: Record<string, unknown> = {
    channel: channel.name || channel.id,
    channel_id: channel.id,
    type: channel.type,
    exported_at: new Date().toISOString(),
  };

  const body = renderMessagesBody(messages, threads, userMap, channelMap);
  await writer.writeDocument(`${basePath}/messages.md`, frontmatter, body);
}

function renderMessagesBody(
  messages: SlackMessage[],
  threads: Map<string, SlackMessage[]>,
  userMap: UserMap,
  channelMap: ChannelMap,
): string {
  if (messages.length === 0) {
    return "_No messages._\n";
  }

  const lines: string[] = [];
  let currentDate = "";

  for (const msg of messages) {
    // Skip deleted messages and noise
    if (msg.subtype === "message_deleted") continue;
    if (shouldSkipMessage(msg, userMap)) continue;

    const dateGroup = getDateGroup(msg.ts);
    if (dateGroup !== currentDate) {
      if (currentDate) lines.push(""); // blank line before new date
      lines.push(`## ${dateGroup}`);
      lines.push("");
      currentDate = dateGroup;
    }

    // Regular message
    const author = getAuthorName(msg, userMap);
    const time = formatTime(msg.ts);
    const text = renderMessageText(msg, userMap, channelMap);

    lines.push(`**${author}** (${time}):`);

    // Multi-line message text
    for (const textLine of text.split("\n")) {
      lines.push(textLine);
    }

    // Reactions
    if (msg.reactions && msg.reactions.length > 0) {
      const reactionStr = msg.reactions
        .map((r) => `:${r.name}: (${r.count})`)
        .join(" ");
      lines.push(`[${reactionStr}]`);
    }

    // Files
    if (msg.files && msg.files.length > 0) {
      for (const file of msg.files) {
        lines.push(`[File: ${file.name} (${formatBytes(file.size)})]`);
      }
    }

    // Inline thread replies (if any)
    const threadReplies = threads.get(msg.ts);
    if (threadReplies && threadReplies.length > 0) {
      lines.push("");
      for (const reply of threadReplies) {
        // Skip the parent message if it appears in replies
        if (reply.ts === msg.ts) continue;

        const replyAuthor = getAuthorName(reply, userMap);
        const replyTime = formatTime(reply.ts);
        const replyText = renderMessageText(reply, userMap, channelMap);

        // Thread replies are indented with >
        lines.push(`> **${replyAuthor}** (${replyTime}) [thread]:`);
        for (const replyLine of replyText.split("\n")) {
          lines.push(`> ${replyLine}`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

// ─── Messages JSONL ───

async function writeMessagesJsonl(
  writer: OutputWriter,
  basePath: string,
  messages: SlackMessage[],
  userMap: UserMap,
  channelMap: ChannelMap,
): Promise<void> {
  const records = messages
    .filter((msg) => msg.subtype !== "message_deleted")
    .map((msg) => buildJsonlRecord(msg, userMap, channelMap));

  await writer.writeJsonl(
    `${basePath}/messages.jsonl`,
    records as unknown as Record<string, unknown>[],
  );
}

function buildJsonlRecord(
  msg: SlackMessage,
  userMap: UserMap,
  channelMap: ChannelMap,
): JsonlRecord {
  const author = getAuthorName(msg, userMap);
  const text = renderMessageText(msg, userMap, channelMap);

  return {
    ts: msg.ts,
    user: msg.userId,
    userName: author,
    text,
    threadTs: msg.threadTs ?? null,
    reactions: msg.reactions ?? [],
    files: (msg.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      mimetype: f.mimetype,
      size: f.size,
    })),
    edited: msg.edited ?? null,
    date: formatTimestamp(msg.ts),
  };
}

// ─── Channel Metadata ───

async function writeChannelMeta(
  writer: OutputWriter,
  basePath: string,
  channel: SlackChannel,
  messages: SlackMessage[],
): Promise<void> {
  const nonDeletedMessages = messages.filter(
    (m) => m.subtype !== "message_deleted",
  );
  const oldestTs =
    nonDeletedMessages.length > 0 ? nonDeletedMessages[0]?.ts : null;
  const newestTs =
    nonDeletedMessages.length > 0
      ? nonDeletedMessages[nonDeletedMessages.length - 1]?.ts
      : null;

  const meta: Record<string, unknown> = {
    channelId: channel.id,
    channelName: channel.name,
    type: channel.type,
    topic: channel.topic,
    purpose: channel.purpose,
    memberCount: channel.memberCount,
    messageCount: nonDeletedMessages.length,
    oldestMessage: oldestTs ? formatTimestamp(oldestTs) : null,
    newestMessage: newestTs ? formatTimestamp(newestTs) : null,
    lastSyncAt: new Date().toISOString(),
  };

  await writer.writeMeta(`${basePath}/_meta.json`, meta);
}

// ─── Thread Documents ───

async function writeThreadDocuments(
  writer: OutputWriter,
  channelSlug: string,
  channel: SlackChannel,
  threads: Map<string, SlackMessage[]>,
  userMap: UserMap,
  channelMap: ChannelMap,
): Promise<void> {
  for (const [threadTs, replies] of threads) {
    if (replies.length === 0) continue;

    const parentMsg = replies[0];
    const parentAuthor = parentMsg
      ? getAuthorName(parentMsg, userMap)
      : "unknown";
    const parentText = parentMsg
      ? renderMessageText(parentMsg, userMap, channelMap)
      : "";

    // Build participants list
    const participantIds = new Set<string>();
    for (const reply of replies) {
      if (reply.userId) participantIds.add(reply.userId);
    }
    const participants = Array.from(participantIds).map((id) => {
      const user = userMap.get(id);
      return user ? user.displayName || user.name : id;
    });

    const frontmatter: Record<string, unknown> = {
      thread_ts: threadTs,
      channel: channel.name || channel.id,
      channel_id: channel.id,
      started_by: parentAuthor,
      participants,
      reply_count: replies.length - 1, // exclude parent
      started_at: formatTimestamp(threadTs),
      exported_at: new Date().toISOString(),
    };

    const lines: string[] = [];

    // Thread topic (parent message as heading)
    lines.push(`# Thread in #${channel.name || channel.id}`);
    lines.push("");
    lines.push(`**${parentAuthor}** started this thread:`);
    lines.push("");
    if (parentText) {
      lines.push(parentText);
      lines.push("");
    }
    lines.push("---");
    lines.push("");

    // Replies
    for (const reply of replies) {
      // Skip the parent if it's the first message
      if (reply.ts === threadTs) continue;

      const author = getAuthorName(reply, userMap);
      const time = formatTime(reply.ts);
      const date = formatDate(reply.ts);
      const text = renderMessageText(reply, userMap, channelMap);

      lines.push(`**${author}** (${date} ${time}):`);
      lines.push(text);

      if (reply.reactions && reply.reactions.length > 0) {
        const reactionStr = reply.reactions
          .map((r: SlackReaction) => `:${r.name}: (${r.count})`)
          .join(" ");
        lines.push(`[${reactionStr}]`);
      }

      lines.push("");
    }

    const body = lines.join("\n");
    const threadPath = `threads/${channelSlug}/${threadTs}.md`;
    await writer.writeDocument(threadPath, frontmatter, body);
  }
}

// ─── Metadata Files (users.json, channels.json) ───

export async function writeUsersIndex(
  writer: OutputWriter,
  userMap: UserMap,
): Promise<void> {
  const users: Record<string, unknown>[] = [];
  for (const user of userMap.values()) {
    users.push({
      id: user.id,
      name: user.name,
      realName: user.realName,
      displayName: user.displayName,
      email: user.email,
      isBot: user.isBot,
      isDeleted: user.isDeleted,
    });
  }
  await writer.writeMeta("_meta/users.json", { users });
}

export async function writeChannelsIndex(
  writer: OutputWriter,
  channels: SlackChannel[],
  slugMap: Map<string, string>,
): Promise<void> {
  const channelList = channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    type: ch.type,
    slug: slugMap.get(ch.id) ?? ch.name,
    topic: ch.topic,
    purpose: ch.purpose,
    memberCount: ch.memberCount,
    isArchived: ch.isArchived,
  }));
  await writer.writeMeta("_meta/channels.json", { channels: channelList });
}

// ─── Helpers ───

const DEPLOY_NOISE_RE =
  /^(DEPLOYING|BUILDING|DEPLOYED|SUCCESS|FAILED|ROLLING BACK)\b/i;

/**
 * Whether a message should be excluded from the rendered markdown output.
 * Filters system events, file-only shares with no text, and noisy bot chatter.
 */
function shouldSkipMessage(msg: SlackMessage, userMap: UserMap): boolean {
  if (isSystemMessage(msg)) return true;

  // Pure file share with no meaningful text
  if (msg.files && msg.files.length > 0 && !msg.text.trim()) return true;

  // Noisy deploy/CI bot messages
  if (msg.botId || msg.botProfile) {
    if (DEPLOY_NOISE_RE.test(msg.text.trim())) return true;
  }

  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
