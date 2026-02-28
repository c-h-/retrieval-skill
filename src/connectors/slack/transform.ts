/**
 * Message text conversion: blocks to text, mention resolution, markdown rendering.
 *
 * Handles Slack's rich text blocks, mrkdwn format, user/channel mention
 * resolution, and conversion to human-readable markdown.
 */

import type { ChannelMap, SlackMessage, UserMap } from "./types.js";

// ─── Mention Resolution ───

/**
 * Resolve `<@U123>` user mentions and `<#C456|general>` channel mentions
 * in Slack mrkdwn text to human-readable names.
 */
export function resolveMentions(
  text: string,
  userMap: UserMap,
  channelMap: ChannelMap,
): string {
  // Resolve user mentions: <@U0123456789> or <@U0123456789|display>
  let resolved = text.replace(
    /<@([A-Z0-9]+)(?:\|([^>]+))?>/g,
    (_match, userId, display) => {
      if (display) return `@${display}`;
      const user = userMap.get(userId);
      return user ? `@${user.displayName || user.name}` : `@${userId}`;
    },
  );

  // Resolve channel mentions: <#C0123456789|general> or <#C0123456789>
  resolved = resolved.replace(
    /<#([A-Z0-9]+)(?:\|([^>]+))?>/g,
    (_match, channelId, display) => {
      if (display) return `#${display}`;
      const channel = channelMap.get(channelId);
      return channel ? `#${channel.name}` : `#${channelId}`;
    },
  );

  // Resolve URLs: <http://example.com|Example> or <http://example.com>
  resolved = resolved.replace(
    /<(https?:\/\/[^|>]+)(?:\|([^>]+))?>/g,
    (_match, url, label) => {
      return label ? `[${label}](${url})` : url;
    },
  );

  // Resolve mailto: <mailto:user@example.com|user@example.com>
  resolved = resolved.replace(
    /<mailto:([^|>]+)(?:\|([^>]+))?>/g,
    (_match, email, label) => {
      return label ?? email;
    },
  );

  // Special mentions
  resolved = resolved.replace(/<!here>/g, "@here");
  resolved = resolved.replace(/<!channel>/g, "@channel");
  resolved = resolved.replace(/<!everyone>/g, "@everyone");
  resolved = resolved.replace(
    /<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g,
    (_match, label) => {
      return label ? `@${label}` : "@group";
    },
  );

  return resolved;
}

// ─── Block Kit to Text ───

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Convert Slack Block Kit blocks to plain text / markdown.
 * Falls back to the message text field if blocks are unavailable or empty.
 */
export function blocksToText(
  blocks: unknown[] | undefined,
  fallbackText: string,
): string {
  if (!blocks || blocks.length === 0) {
    return fallbackText;
  }

  const parts: string[] = [];

  for (const block of blocks as any[]) {
    const text = blockToText(block);
    if (text) parts.push(text);
  }

  return parts.length > 0 ? parts.join("\n\n") : fallbackText;
}

function blockToText(block: any): string {
  switch (block.type) {
    case "rich_text":
      return richTextBlockToText(block);
    case "section":
      return sectionBlockToText(block);
    case "header":
      return headerBlockToText(block);
    case "context":
      return contextBlockToText(block);
    case "divider":
      return "---";
    case "image":
      return imageBlockToText(block);
    case "actions":
      return ""; // interactive elements, skip
    case "input":
      return ""; // form elements, skip
    default:
      return "";
  }
}

function richTextBlockToText(block: any): string {
  const elements = block.elements ?? [];
  return elements.map(richTextElementToText).join("");
}

function richTextElementToText(element: any): string {
  switch (element.type) {
    case "rich_text_section":
      return richTextSectionElements(element.elements ?? []);
    case "rich_text_list": {
      const items = (element.elements ?? []).map((item: any, i: number) => {
        const text = richTextSectionElements(item.elements ?? []);
        const prefix = element.style === "ordered" ? `${i + 1}. ` : "- ";
        return `${prefix}${text}`;
      });
      return items.join("\n");
    }
    case "rich_text_quote": {
      const text = richTextSectionElements(element.elements ?? []);
      return text
        .split("\n")
        .map((line: string) => `> ${line}`)
        .join("\n");
    }
    case "rich_text_preformatted": {
      const text = richTextSectionElements(element.elements ?? []);
      return `\`\`\`\n${text}\n\`\`\``;
    }
    default:
      return "";
  }
}

function richTextSectionElements(elements: any[]): string {
  return elements.map(inlineElementToText).join("");
}

function inlineElementToText(el: any): string {
  switch (el.type) {
    case "text": {
      let text = el.text ?? "";
      const style = el.style ?? {};
      if (style.code) text = `\`${text}\``;
      if (style.bold) text = `**${text}**`;
      if (style.italic) text = `_${text}_`;
      if (style.strike) text = `~~${text}~~`;
      return text;
    }
    case "link":
      return el.text ? `[${el.text}](${el.url})` : (el.url ?? "");
    case "emoji":
      return `:${el.name}:`;
    case "user":
      // Will be resolved later by resolveMentions
      return `<@${el.user_id}>`;
    case "usergroup":
      return `<!subteam^${el.usergroup_id}>`;
    case "channel":
      return `<#${el.channel_id}>`;
    case "broadcast":
      return `<!${el.range}>`;
    default:
      return el.text ?? "";
  }
}

function sectionBlockToText(block: any): string {
  const parts: string[] = [];
  if (block.text) {
    parts.push(extractTextObj(block.text));
  }
  if (block.fields) {
    for (const field of block.fields) {
      parts.push(extractTextObj(field));
    }
  }
  return parts.join("\n");
}

function headerBlockToText(block: any): string {
  const text = block.text ? extractTextObj(block.text) : "";
  return `### ${text}`;
}

function contextBlockToText(block: any): string {
  const elements = block.elements ?? [];
  return elements
    .map((el: any) => {
      if (el.type === "image") return `[${el.alt_text ?? "image"}]`;
      return extractTextObj(el);
    })
    .join(" | ");
}

function imageBlockToText(block: any): string {
  const alt = block.alt_text ?? "image";
  return `[Image: ${alt}]`;
}

function extractTextObj(textObj: any): string {
  if (typeof textObj === "string") return textObj;
  return textObj?.text ?? "";
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Mrkdwn Conversion ───

/**
 * Convert Slack mrkdwn formatting to standard Markdown.
 * Slack uses *bold*, _italic_, ~strikethrough~, ```code```, etc.
 */
export function mrkdwnToMarkdown(text: string): string {
  // Slack *bold* -> Markdown **bold**
  // Be careful not to convert already-doubled asterisks
  let result = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "**$1**");

  // Slack _italic_ is already Markdown _italic_, keep as-is

  // Slack ~strikethrough~ -> Markdown ~~strikethrough~~
  result = result.replace(/(?<!~)~([^~\n]+)~(?!~)/g, "~~$1~~");

  return result;
}

// ─── High-Level Message Rendering ───

/**
 * Render a single message to markdown text suitable for inclusion in
 * a channel messages.md file.
 */
export function renderMessageText(
  message: SlackMessage,
  userMap: UserMap,
  channelMap: ChannelMap,
): string {
  // Start with blocks if available, fall back to text
  let text = blocksToText(message.blocks, message.text);

  // Resolve mentions
  text = resolveMentions(text, userMap, channelMap);

  // Convert mrkdwn to standard markdown
  text = mrkdwnToMarkdown(text);

  return text;
}

/**
 * Get display name for a message author.
 */
export function getAuthorName(message: SlackMessage, userMap: UserMap): string {
  if (message.userId) {
    const user = userMap.get(message.userId);
    if (user) {
      return user.displayName || user.realName || user.name;
    }
  }
  if (message.botProfile?.name) return message.botProfile.name;
  if (message.username) return message.username;
  if (message.botId) return `bot:${message.botId}`;
  return "unknown";
}

/**
 * Format a Slack timestamp to a human-readable time string.
 */
export function formatTimestamp(ts: string): string {
  const epochSeconds = parseFloat(ts);
  if (Number.isNaN(epochSeconds)) return ts;
  const date = new Date(epochSeconds * 1000);
  return date.toISOString();
}

/**
 * Format a Slack timestamp to a short time like "09:15 AM".
 */
export function formatTime(ts: string): string {
  const epochSeconds = parseFloat(ts);
  if (Number.isNaN(epochSeconds)) return ts;
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Format a Slack timestamp to a date string like "2026-02-11".
 */
export function formatDate(ts: string): string {
  const epochSeconds = parseFloat(ts);
  if (Number.isNaN(epochSeconds)) return ts;
  const date = new Date(epochSeconds * 1000);
  return date.toISOString().split("T")[0]!;
}

/**
 * Get the date portion from a Slack ts for grouping by day.
 */
export function getDateGroup(ts: string): string {
  return formatDate(ts);
}

// ─── System Message Detection ───

const SYSTEM_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "pinned_item",
  "unpinned_item",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
]);

/**
 * Whether the message is a system/join/leave event (not user content).
 */
export function isSystemMessage(message: SlackMessage): boolean {
  return message.subtype !== undefined && SYSTEM_SUBTYPES.has(message.subtype);
}

/**
 * Render a system message as a short italic line.
 */
export function renderSystemMessage(
  message: SlackMessage,
  userMap: UserMap,
): string {
  const author = getAuthorName(message, userMap);
  switch (message.subtype) {
    case "channel_join":
    case "group_join":
      return `_${author} joined the channel_`;
    case "channel_leave":
    case "group_leave":
      return `_${author} left the channel_`;
    case "channel_topic":
    case "group_topic":
      return `_${author} set the channel topic: ${message.text}_`;
    case "channel_purpose":
    case "group_purpose":
      return `_${author} set the channel purpose: ${message.text}_`;
    case "pinned_item":
      return `_${author} pinned a message_`;
    default:
      return `_${message.subtype}: ${message.text}_`;
  }
}
