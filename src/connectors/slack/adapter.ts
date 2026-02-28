/**
 * Slack Adapter — Main sync orchestrator.
 *
 * Implements the Adapter interface from @saas-mirror/core.
 * Supports both full hydration and incremental sync modes.
 */

import type {
  Adapter,
  Logger,
  OutputWriter,
  SyncContext,
  SyncError,
  SyncResult,
} from "../core/index.js";
import {
  createOutputWriter,
  sanitizeFilename,
  slugify,
  withRetry,
} from "../core/index.js";
import { SlackApi } from "./api.js";
import type {
  ChannelExportData,
  ChannelMap,
  SlackAuthInfo,
  SlackChannel,
  SlackMessage,
  SlackSyncMetadata,
  UserMap,
} from "./types.js";
import {
  appendChannelOutput,
  writeChannelOutput,
  writeChannelsIndex,
  writeUsersIndex,
} from "./writer.js";

// ─── Constants ───

const ADAPTER_NAME = "slack";
const USERS_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Adapter ───

export class SlackAdapter implements Adapter {
  readonly name = ADAPTER_NAME;

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: SyncError[] = [];
    let itemsSynced = 0;
    let itemsFailed = 0;

    const { mode, outputDir, state, logger, signal } = ctx;

    // Resolve token
    const token = process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_TOKEN;
    if (!token) {
      return errorResult(mode, startTime, [
        {
          entity: "auth",
          error: "Missing SLACK_BOT_TOKEN environment variable",
          retryable: false,
        },
      ]);
    }

    // Config from env
    const skipDMs = process.env.SLACK_SKIP_DMS === "true";
    const skipFiles = process.env.SLACK_SKIP_FILES === "true";

    // Initialize API client and output writer
    const api = new SlackApi(token, ctx.rateLimiter, logger);
    const writer = createOutputWriter(outputDir);

    // Authenticate
    logger.info("Authenticating with Slack...");
    let authInfo: SlackAuthInfo;
    try {
      authInfo = await withRetry(() => api.authenticate(), { maxRetries: 2 });
    } catch (err) {
      return errorResult(mode, startTime, [
        {
          entity: "auth",
          error: `Authentication failed: ${errorMessage(err)}`,
          retryable: false,
        },
      ]);
    }
    logger.info("Authenticated", {
      team: authInfo.teamName,
      teamId: authInfo.teamId,
    });

    // Load or initialize metadata
    const metadata = loadMetadata(state.metadata);

    // Fetch users
    const userMap: UserMap = new Map();
    try {
      await fetchAndMapUsers(
        api,
        userMap,
        writer,
        metadata,
        mode,
        logger,
        signal,
      );
    } catch (err) {
      errors.push({
        entity: "users",
        error: `Failed to fetch users: ${errorMessage(err)}`,
        retryable: true,
      });
      logger.error("Failed to fetch users", { error: errorMessage(err) });
    }

    // Fetch channels
    let channels: SlackChannel[] = [];
    try {
      channels = await fetchChannels(api, skipDMs, logger, signal);
    } catch (err) {
      return errorResult(mode, startTime, [
        {
          entity: "channels",
          error: `Failed to fetch channels: ${errorMessage(err)}`,
          retryable: true,
        },
        ...errors,
      ]);
    }

    // Build channel map for mention resolution
    const channelMap: ChannelMap = new Map();
    for (const ch of channels) {
      channelMap.set(ch.id, ch);
    }

    // Build slug map for channel directories
    const slugMap = buildSlugMap(channels, userMap);

    // Write metadata indices
    try {
      await writeUsersIndex(writer, userMap);
      await writeChannelsIndex(writer, channels, slugMap);
    } catch (err) {
      logger.warn("Failed to write metadata indices", {
        error: errorMessage(err),
      });
    }

    // Update known channels
    metadata.knownChannelIds = channels.map((ch) => ch.id);
    metadata.lastChannelListAt = new Date().toISOString();

    // Determine which channels to process
    const channelsToProcess = selectChannels(channels, metadata, mode);
    logger.info(
      `Processing ${channelsToProcess.length} channels (mode: ${mode})`,
    );

    // Process each channel with per-channel error isolation
    for (let i = 0; i < channelsToProcess.length; i++) {
      const channel = channelsToProcess[i]!;
      const slug =
        slugMap.get(channel.id) ?? slugify(channel.name || channel.id);

      throwIfAborted(signal);

      logger.progress(i + 1, channelsToProcess.length, "Channels");

      try {
        const channelResult = await processChannel(
          api,
          writer,
          channel,
          slug,
          userMap,
          channelMap,
          metadata,
          mode,
          skipFiles,
          token,
          logger,
          signal,
        );

        itemsSynced += channelResult.synced;
        itemsFailed += channelResult.failed;
        errors.push(...channelResult.errors);

        // Mark channel as hydrated (for full sync resumability)
        if (
          mode === "full" &&
          !metadata.hydratedChannels.includes(channel.id)
        ) {
          metadata.hydratedChannels.push(channel.id);
        }

        // Remove from failed list on success
        metadata.failedChannels = metadata.failedChannels.filter(
          (id) => id !== channel.id,
        );
      } catch (err) {
        itemsFailed++;
        const syncError: SyncError = {
          entity: `channel:${channel.name || channel.id}`,
          error: errorMessage(err),
          retryable: isRetryableError(err),
        };
        errors.push(syncError);
        logger.error(
          `Failed to process channel: ${channel.name || channel.id}`,
          {
            error: errorMessage(err),
          },
        );

        // Track failed channel for retry
        if (!metadata.failedChannels.includes(channel.id)) {
          metadata.failedChannels.push(channel.id);
        }
      }

      // Checkpoint state after each channel
      try {
        saveMetadata(state, metadata);
        await state.checkpoint();
      } catch (err) {
        logger.warn("Failed to checkpoint state", { error: errorMessage(err) });
      }
    }

    // Final state save
    saveMetadata(state, metadata);
    state.lastSyncAt = new Date().toISOString();
    await state.checkpoint();

    const durationMs = Date.now() - startTime;
    logger.info(
      `Sync complete: ${itemsSynced} synced, ${itemsFailed} failed in ${durationMs}ms`,
    );

    return {
      adapter: ADAPTER_NAME,
      mode,
      itemsSynced,
      itemsFailed,
      errors,
      durationMs,
    };
  }
}

// ─── Channel Processing ───

interface ChannelProcessResult {
  synced: number;
  failed: number;
  errors: SyncError[];
}

async function processChannel(
  api: SlackApi,
  writer: OutputWriter,
  channel: SlackChannel,
  slug: string,
  userMap: UserMap,
  channelMap: ChannelMap,
  metadata: SlackSyncMetadata,
  mode: "full" | "incremental",
  skipFiles: boolean,
  _token: string,
  logger: Logger,
  signal: AbortSignal,
): Promise<ChannelProcessResult> {
  const errors: SyncError[] = [];
  let synced = 0;
  let failed = 0;

  const channelLabel = channel.name || channel.id;
  logger.info(`Processing channel: ${channelLabel} (${channel.type})`);

  // Determine oldest parameter for incremental
  const oldest =
    mode === "incremental"
      ? (metadata.channelHighWaterMark[channel.id] ?? undefined)
      : undefined;

  // Fetch messages
  let messages: SlackMessage[];
  try {
    messages = await withRetry(
      () => api.fetchChannelHistory(channel.id, signal, oldest),
      {
        maxRetries: 3,
        retryOn: (err) => isRetryableError(err),
      },
    );
  } catch (err) {
    throw new Error(
      `Failed to fetch history for ${channelLabel}: ${errorMessage(err)}`,
    );
  }

  logger.info(`Fetched ${messages.length} messages from ${channelLabel}`);

  // Fetch thread replies for messages with reply_count > 0
  const threads = new Map<string, SlackMessage[]>();
  const threadParents = messages.filter(
    (msg) => (msg.replyCount ?? 0) > 0 && msg.ts === (msg.threadTs ?? msg.ts),
  );

  for (const parent of threadParents) {
    throwIfAborted(signal);

    try {
      const threadOldest =
        mode === "incremental"
          ? (metadata.threadHighWaterMark[parent.ts] ?? undefined)
          : undefined;

      const replies = await withRetry(
        () =>
          api.fetchThreadReplies(channel.id, parent.ts, signal, threadOldest),
        {
          maxRetries: 2,
          retryOn: (err) => isRetryableError(err),
        },
      );

      threads.set(parent.ts, replies);

      // Update thread high water mark
      if (replies.length > 0) {
        const latestReplyTs = replies[replies.length - 1]?.ts;
        const existingHwm = metadata.threadHighWaterMark[parent.ts];
        if (!existingHwm || latestReplyTs > existingHwm) {
          metadata.threadHighWaterMark[parent.ts] = latestReplyTs;
        }
      }

      synced += replies.length;
    } catch (err) {
      failed++;
      errors.push({
        entity: `thread:${channelLabel}/${parent.ts}`,
        error: errorMessage(err),
        retryable: isRetryableError(err),
      });
      logger.warn(`Failed to fetch thread ${parent.ts} in ${channelLabel}`, {
        error: errorMessage(err),
      });
    }
  }

  // Download files (unless skipped)
  if (!skipFiles) {
    for (const msg of messages) {
      for (const file of msg.files ?? []) {
        if (!file.urlPrivateDownload) continue;

        throwIfAborted(signal);

        try {
          const fileData = await withRetry(
            () => api.downloadFile(file.urlPrivateDownload, signal),
            {
              maxRetries: 2,
              retryOn: (err) => isRetryableError(err),
            },
          );

          const safeName = sanitizeFilename(file.name);
          await writer.writeBinary(`files/${file.id}/${safeName}`, fileData);
          synced++;
        } catch (err) {
          failed++;
          errors.push({
            entity: `file:${file.id}/${file.name}`,
            error: errorMessage(err),
            retryable: isRetryableError(err),
          });
          logger.warn(`Failed to download file ${file.name}`, {
            error: errorMessage(err),
          });
        }
      }
    }
  }

  // Write output files
  const exportData: ChannelExportData = {
    channel,
    slug,
    messages,
    threads,
    userMap,
  };

  if (mode === "full") {
    await writeChannelOutput(writer, exportData, channelMap);
  } else {
    await appendChannelOutput(writer, exportData, channelMap);
  }

  // Update channel high water mark
  if (messages.length > 0) {
    const latestTs = messages[messages.length - 1]?.ts;
    const existingHwm = metadata.channelHighWaterMark[channel.id];
    if (!existingHwm || latestTs > existingHwm) {
      metadata.channelHighWaterMark[channel.id] = latestTs;
    }
  }

  synced += messages.length;
  return { synced, failed, errors };
}

// ─── User Fetching ───

async function fetchAndMapUsers(
  api: SlackApi,
  userMap: UserMap,
  _writer: OutputWriter,
  metadata: SlackSyncMetadata,
  mode: "full" | "incremental",
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  const shouldRefresh =
    mode === "full" ||
    !metadata.lastUsersRefreshAt ||
    Date.now() - new Date(metadata.lastUsersRefreshAt).getTime() >
      USERS_REFRESH_INTERVAL_MS;

  if (!shouldRefresh) {
    logger.info("Skipping user refresh (within interval)");
    return;
  }

  logger.info("Fetching users...");
  const users = await withRetry(() => api.fetchAllUsers(signal), {
    maxRetries: 2,
  });

  for (const user of users) {
    userMap.set(user.id, user);
  }

  metadata.lastUsersRefreshAt = new Date().toISOString();
  logger.info(`Fetched ${users.length} users`);
}

// ─── Channel Fetching ───

async function fetchChannels(
  api: SlackApi,
  skipDMs: boolean,
  logger: Logger,
  signal: AbortSignal,
): Promise<SlackChannel[]> {
  const types = skipDMs
    ? "public_channel,private_channel"
    : "public_channel,private_channel,im,mpim";

  logger.info("Fetching channels...", { types });
  const channels = await withRetry(() => api.fetchAllChannels(signal, types), {
    maxRetries: 2,
  });
  logger.info(`Fetched ${channels.length} channels`);
  return channels;
}

// ─── Slug Mapping ───

function buildSlugMap(
  channels: SlackChannel[],
  userMap: UserMap,
): Map<string, string> {
  const slugMap = new Map<string, string>();
  const usedSlugs = new Set<string>();

  for (const ch of channels) {
    let slug: string;

    if (ch.type === "im") {
      // DM: dm--user1--user2 (sorted)
      const names = resolveImParticipants(ch, userMap);
      slug = `dm--${names.join("--")}`;
    } else if (ch.type === "mpim") {
      // Group DM: mpim--user1--user2--user3 (sorted)
      const names = resolveMpimParticipants(ch, userMap);
      slug = `mpim--${names.join("--")}`;
    } else {
      slug = slugify(ch.name || ch.id);
    }

    // Ensure uniqueness
    if (usedSlugs.has(slug)) {
      slug = `${slug}--${ch.id}`;
    }
    usedSlugs.add(slug);
    slugMap.set(ch.id, slug);
  }

  return slugMap;
}

function resolveImParticipants(
  channel: SlackChannel,
  userMap: UserMap,
): string[] {
  // IM channel name is often the user ID. Try to resolve it.
  const userId = channel.name || channel.id;
  const user = userMap.get(userId);
  const name = user ? slugify(user.name || user.displayName) : slugify(userId);
  return [name].filter(Boolean).sort();
}

function resolveMpimParticipants(
  channel: SlackChannel,
  _userMap: UserMap,
): string[] {
  // MPIM channel names look like "mpdm-user1--user2--user3-1"
  const match = channel.name.match(/^mpdm-(.*)-\d+$/);
  if (match?.[1]) {
    const parts = match[1].split("--");
    return parts
      .map((p) => slugify(p))
      .filter(Boolean)
      .sort();
  }
  return [slugify(channel.name || channel.id)];
}

// ─── Channel Selection ───

function selectChannels(
  channels: SlackChannel[],
  metadata: SlackSyncMetadata,
  mode: "full" | "incremental",
): SlackChannel[] {
  if (mode === "full") {
    // For full sync, skip already-hydrated channels (resumability)
    return channels.filter((ch) => !metadata.hydratedChannels.includes(ch.id));
  }

  // For incremental, process all channels (including previously failed ones)
  return channels;
}

// ─── Metadata Helpers ───

function loadMetadata(raw: Record<string, unknown>): SlackSyncMetadata {
  return {
    channelHighWaterMark:
      (raw.channelHighWaterMark as Record<string, string>) ?? {},
    threadHighWaterMark:
      (raw.threadHighWaterMark as Record<string, string>) ?? {},
    lastChannelListAt: (raw.lastChannelListAt as string) ?? null,
    knownChannelIds: (raw.knownChannelIds as string[]) ?? [],
    lastUsersRefreshAt: (raw.lastUsersRefreshAt as string) ?? null,
    hydratedChannels: (raw.hydratedChannels as string[]) ?? [],
    failedChannels: (raw.failedChannels as string[]) ?? [],
  };
}

function saveMetadata(
  state: { metadata: Record<string, unknown> },
  metadata: SlackSyncMetadata,
): void {
  state.metadata = {
    channelHighWaterMark: metadata.channelHighWaterMark,
    threadHighWaterMark: metadata.threadHighWaterMark,
    lastChannelListAt: metadata.lastChannelListAt,
    knownChannelIds: metadata.knownChannelIds,
    lastUsersRefreshAt: metadata.lastUsersRefreshAt,
    hydratedChannels: metadata.hydratedChannels,
    failedChannels: metadata.failedChannels,
  };
}

// ─── Error Helpers ───

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("enotfound") ||
      msg.includes("socket hang up") ||
      msg.includes("fetch failed") ||
      msg.includes("rate limit")
    ) {
      return true;
    }
  }
  const status = (err as { status?: number }).status;
  if (status && status >= 500 && status < 600) return true;
  if (status === 429) return true;
  return false;
}

function errorResult(
  mode: "full" | "incremental",
  startTime: number,
  errors: SyncError[],
): SyncResult {
  return {
    adapter: ADAPTER_NAME,
    mode,
    itemsSynced: 0,
    itemsFailed: errors.length,
    errors,
    durationMs: Date.now() - startTime,
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Sync aborted");
  }
}
