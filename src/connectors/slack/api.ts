/**
 * Rate-limited Slack API wrapper using @slack/web-api WebClient.
 *
 * Handles pagination, rate limiting (429 + Retry-After), and maps
 * raw API responses to our internal Slack types.
 */

import type { Logger, RateLimiter } from "../core/index.js";
import { WebClient } from "@slack/web-api";
import type {
  SlackAuthInfo,
  SlackChannel,
  SlackFile,
  SlackMessage,
  SlackReaction,
  SlackUser,
} from "./types.js";

/** Tier-based minimum delays (ms) between calls. */
const TIER_DELAY: Record<number, number> = {
  2: 1200, // ~50 req/min
  3: 600, // ~100 req/min
  4: 200, // ~300 req/min
};

export class SlackApi {
  private readonly client: WebClient;
  private readonly token: string;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;

  constructor(token: string, rateLimiter: RateLimiter, logger: Logger) {
    this.token = token;
    this.client = new WebClient(token, {
      // We handle rate limiting ourselves
      rejectRateLimitedCalls: false,
      retryConfig: { retries: 0 },
    });
    this.rateLimiter = rateLimiter;
    this.logger = logger;
  }

  // ─── Rate-Limited Call Wrapper ───

  private async call<T>(
    fn: () => Promise<T>,
    tier: number,
    label: string,
  ): Promise<T> {
    await this.rateLimiter.acquire();

    try {
      const result = await fn();
      // Enforce tier-based delay after successful call
      const delay = TIER_DELAY[tier] ?? 600;
      await sleep(delay);
      return result;
    } catch (err: unknown) {
      if (isRateLimitError(err)) {
        const retryAfter = extractRetryAfter(err);
        this.logger.warn(
          `Rate limited on ${label}, retrying in ${retryAfter}s`,
        );
        const backoffMs = (retryAfter + 1) * 1000;
        this.rateLimiter.backoff(backoffMs);
        await sleep(backoffMs);
        return this.call(fn, tier, label);
      }
      throw err;
    }
  }

  // ─── Auth ───

  async authenticate(): Promise<SlackAuthInfo> {
    const resp = await this.call(() => this.client.auth.test(), 4, "auth.test");

    if (!resp.ok) {
      throw new Error(`auth.test failed: ${resp.error ?? "unknown error"}`);
    }

    return {
      teamId: resp.team_id as string,
      teamName: (resp.team as string) ?? "unknown",
      userId: resp.user_id as string,
      botId: resp.bot_id as string | undefined,
    };
  }

  // ─── Users ───

  async fetchAllUsers(signal: AbortSignal): Promise<SlackUser[]> {
    const users: SlackUser[] = [];
    let cursor: string | undefined;

    do {
      throwIfAborted(signal);

      const resp = await this.call(
        () =>
          this.client.users.list({
            limit: 200,
            cursor: cursor || undefined,
          }),
        2,
        "users.list",
      );

      if (!resp.ok) {
        throw new Error(`users.list failed: ${resp.error ?? "unknown"}`);
      }

      for (const member of resp.members ?? []) {
        users.push(mapUser(member));
      }

      cursor = resp.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return users;
  }

  // ─── Channels ───

  async fetchAllChannels(
    signal: AbortSignal,
    includeTypes = "public_channel,private_channel,im,mpim",
  ): Promise<SlackChannel[]> {
    const channels: SlackChannel[] = [];

    // Split types and fetch each independently to handle missing scopes gracefully
    const types = includeTypes.split(",").map((t) => t.trim());
    for (const type of types) {
      let cursor: string | undefined;
      try {
        do {
          throwIfAborted(signal);

          const resp = await this.call(
            () =>
              this.client.conversations.list({
                types: type,
                limit: 200,
                cursor: cursor || undefined,
                exclude_archived: false,
              }),
            2,
            `conversations.list(${type})`,
          );

          if (!resp.ok) {
            throw new Error(
              `conversations.list failed: ${resp.error ?? "unknown"}`,
            );
          }

          for (const ch of resp.channels ?? []) {
            channels.push(mapChannel(ch));
          }

          cursor = resp.response_metadata?.next_cursor || undefined;
        } while (cursor);
      } catch (err: unknown) {
        if (isMissingScopeError(err)) {
          this.logger.warn(`Skipping ${type} channels (missing scope)`);
          continue;
        }
        throw err;
      }
    }

    return channels;
  }

  // ─── Channel History ───

  async fetchChannelHistory(
    channelId: string,
    signal: AbortSignal,
    oldest?: string,
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
      throwIfAborted(signal);

      const resp = await this.call(
        () =>
          this.client.conversations.history({
            channel: channelId,
            limit: 200,
            cursor: cursor || undefined,
            oldest: oldest || undefined,
          }),
        3,
        `conversations.history(${channelId})`,
      );

      if (!resp.ok) {
        throw new Error(
          `conversations.history failed for ${channelId}: ${resp.error ?? "unknown"}`,
        );
      }

      for (const msg of resp.messages ?? []) {
        messages.push(mapMessage(msg, channelId));
      }

      cursor = resp.has_more
        ? resp.response_metadata?.next_cursor || undefined
        : undefined;
    } while (cursor);

    // API returns newest first; reverse to get chronological order
    messages.reverse();
    return messages;
  }

  // ─── Thread Replies ───

  async fetchThreadReplies(
    channelId: string,
    threadTs: string,
    signal: AbortSignal,
    oldest?: string,
  ): Promise<SlackMessage[]> {
    const replies: SlackMessage[] = [];
    let cursor: string | undefined;

    do {
      throwIfAborted(signal);

      const resp = await this.call(
        () =>
          this.client.conversations.replies({
            channel: channelId,
            ts: threadTs,
            limit: 200,
            cursor: cursor || undefined,
            oldest: oldest || undefined,
          }),
        3,
        `conversations.replies(${channelId}, ${threadTs})`,
      );

      if (!resp.ok) {
        throw new Error(
          `conversations.replies failed for ${channelId}/${threadTs}: ${resp.error ?? "unknown"}`,
        );
      }

      for (const msg of resp.messages ?? []) {
        replies.push(mapMessage(msg, channelId));
      }

      cursor = resp.has_more
        ? resp.response_metadata?.next_cursor || undefined
        : undefined;
    } while (cursor);

    return replies;
  }

  // ─── File Download ───

  async downloadFile(url: string, signal: AbortSignal): Promise<Buffer> {
    throwIfAborted(signal);

    const resp = await this.call(
      async () => {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}` },
          signal,
        });
        if (!res.ok) {
          throw new Error(
            `File download failed: ${res.status} ${res.statusText}`,
          );
        }
        return Buffer.from(await res.arrayBuffer());
      },
      3,
      `file download`,
    );

    return resp;
  }
}

// ─── Mappers ───

/* eslint-disable @typescript-eslint/no-explicit-any */

function mapUser(raw: any): SlackUser {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    realName: raw.real_name ?? raw.profile?.real_name ?? "",
    displayName: raw.profile?.display_name ?? raw.name ?? "",
    email: raw.profile?.email,
    isBot: raw.is_bot ?? false,
    isDeleted: raw.deleted ?? false,
    avatar72: raw.profile?.image_72 ?? "",
  };
}

function mapChannel(raw: any): SlackChannel {
  let channelType: SlackChannel["type"] = "public";
  if (raw.is_im) channelType = "im";
  else if (raw.is_mpim) channelType = "mpim";
  else if (raw.is_private || raw.is_group) channelType = "private";

  return {
    id: raw.id ?? "",
    name: raw.name ?? raw.name_normalized ?? "",
    type: channelType,
    topic: raw.topic?.value ?? "",
    purpose: raw.purpose?.value ?? "",
    memberCount: raw.num_members ?? 0,
    isArchived: raw.is_archived ?? false,
    created: raw.created ?? 0,
  };
}

function mapMessage(raw: any, channelId: string): SlackMessage {
  return {
    ts: raw.ts ?? "",
    channelId,
    userId: raw.user ?? "",
    text: raw.text ?? "",
    blocks: raw.blocks,
    threadTs: raw.thread_ts,
    replyCount: raw.reply_count ?? 0,
    reactions: (raw.reactions ?? []).map(mapReaction),
    files: (raw.files ?? []).map(mapFile),
    edited: raw.edited
      ? { user: raw.edited.user ?? "", ts: raw.edited.ts ?? "" }
      : undefined,
    subtype: raw.subtype,
    botId: raw.bot_id,
    botProfile: raw.bot_profile?.name
      ? { name: raw.bot_profile.name }
      : undefined,
    username: raw.username,
  };
}

function mapReaction(raw: any): SlackReaction {
  return {
    name: raw.name ?? "",
    count: raw.count ?? 0,
    users: raw.users ?? [],
  };
}

function mapFile(raw: any): SlackFile {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "unnamed",
    mimetype: raw.mimetype ?? "application/octet-stream",
    size: raw.size ?? 0,
    urlPrivateDownload: raw.url_private_download ?? raw.url_private ?? "",
    permalink: raw.permalink ?? "",
    createdAt: raw.created ?? 0,
  };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingScopeError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    const data = obj.data as Record<string, unknown> | undefined;
    if (data?.error === "missing_scope") return true;
    if (
      obj.code === "slack_webapi_platform_error" &&
      data?.error === "missing_scope"
    )
      return true;
    if (
      typeof obj.message === "string" &&
      obj.message.includes("missing_scope")
    )
      return true;
  }
  return false;
}

function isRateLimitError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (obj.code === "slack_webapi_rate_limited_error") return true;
    if (obj.statusCode === 429 || obj.status === 429) return true;
    const data = obj.data as Record<string, unknown> | undefined;
    if (data?.error === "ratelimited") return true;
  }
  return false;
}

function extractRetryAfter(err: unknown): number {
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (typeof obj.retryAfter === "number") return obj.retryAfter;
    const headers = obj.headers as Record<string, string> | undefined;
    if (headers?.["retry-after"]) {
      return parseInt(headers["retry-after"], 10) || 30;
    }
  }
  return 30;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Sync aborted");
  }
}
