/**
 * GOG Adapter — Gmail sync via the `gog` CLI.
 *
 * Uses `gog` (an open-source Go CLI by steipete — https://github.com/steipete/gogcli)
 * wrapping Gmail/Google APIs with its own OAuth keyring, instead of raw googleapis credentials.
 *
 * Supports full hydration and incremental sync via Gmail History API.
 */

import type {
  Adapter,
  Logger,
  OutputWriter,
  SyncContext,
  SyncError,
  SyncResult,
} from "../core/index.js";
import { createOutputWriter, withRetry } from "../core/index.js";
import { GogCli } from "./cli.js";
import type {
  GogLabel,
  GogMessageFull,
  GogMimePart,
  GogSyncMetadata,
} from "./types.js";
import {
  removeMessage,
  writeLabels,
  writeMessage,
  writeThreadView,
} from "./writer.js";

// ─── Constants ───

const ADAPTER_NAME = "gog";
const SEARCH_BATCH_SIZE = 500;
const FETCH_CONCURRENCY = 2;
/** Delay between GOG CLI calls to stay within Gmail API quota (ms) */
const CALL_DELAY_MS = 1500;

// ─── Adapter ───

export class GogAdapter implements Adapter {
  readonly name = ADAPTER_NAME;

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: SyncError[] = [];
    let itemsSynced = 0;
    let itemsFailed = 0;

    const { mode, outputDir, state, logger, signal } = ctx;

    // Config
    const account = process.env.GOG_ACCOUNT;
    if (!account) {
      throw new Error("GOG_ACCOUNT environment variable is required");
    }
    const gogPath = process.env.GOG_PATH;

    const cli = new GogCli(account, logger, gogPath);
    const writer = createOutputWriter(outputDir);

    // Load metadata
    const metadata = loadMetadata(state.metadata);
    metadata.emailAddress = account;

    // Fetch labels
    logger.info("Fetching labels...");
    let labels: GogLabel[] = [];
    try {
      labels = await withRetry(() => cli.listLabels(), { maxRetries: 2 });
      await writeLabels(writer, labels);
      logger.info(`Fetched ${labels.length} labels`);
    } catch (err) {
      errors.push({
        entity: "labels",
        error: `Failed to fetch labels: ${errorMessage(err)}`,
        retryable: true,
      });
      logger.error("Failed to fetch labels", { error: errorMessage(err) });
    }

    const labelMap = new Map(labels.map((l) => [l.id, l.name]));

    // Dispatch to full or incremental
    if (mode === "full" || !metadata.historyId) {
      const result = await fullSync(
        cli,
        writer,
        labelMap,
        metadata,
        logger,
        signal,
      );
      itemsSynced += result.synced;
      itemsFailed += result.failed;
      errors.push(...result.errors);
    } else {
      const result = await incrementalSync(
        cli,
        writer,
        labelMap,
        metadata,
        logger,
        signal,
      );
      itemsSynced += result.synced;
      itemsFailed += result.failed;
      errors.push(...result.errors);
    }

    // Save state
    saveMetadata(state, metadata);
    state.lastSyncAt = new Date().toISOString();
    await state.checkpoint();

    const durationMs = Date.now() - startTime;
    logger.info(`Sync complete: ${itemsSynced} items, ${itemsFailed} failed`, {
      durationMs,
    });

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

// ─── Full Sync ───

interface SyncBatchResult {
  synced: number;
  failed: number;
  errors: SyncError[];
}

async function fullSync(
  cli: GogCli,
  writer: OutputWriter,
  labelMap: Map<string, string>,
  metadata: GogSyncMetadata,
  logger: Logger,
  signal: AbortSignal,
): Promise<SyncBatchResult> {
  const errors: SyncError[] = [];
  let synced = 0;
  let failed = 0;

  logger.info("Starting full sync — listing all message IDs");

  // Phase 1: List all message IDs via search
  const allMessageIds: string[] = [];
  let pageToken: string | undefined;
  let highestHistoryId: string | null = null;

  do {
    throwIfAborted(signal);

    const batch = await withRetry(
      () => cli.searchMessages("in:anywhere", SEARCH_BATCH_SIZE, pageToken),
      { maxRetries: 5, retryOn: (err) => isRateLimitError(err) },
    );

    for (const msg of batch.messages) {
      allMessageIds.push(msg.id);
    }

    pageToken = batch.nextPageToken;
    logger.info(`Listed ${allMessageIds.length} messages so far...`);

    // Pace to avoid Gmail API rate limits
    await sleep(CALL_DELAY_MS);
  } while (pageToken);

  logger.info(`Total messages to fetch: ${allMessageIds.length}`);
  metadata.totalMessages = allMessageIds.length;

  // Phase 2: Fetch each message
  // Skip already-fetched messages (resumability)
  const alreadyFetched = new Set(metadata.fetchedMessageIds);
  const toFetch = allMessageIds.filter((id) => !alreadyFetched.has(id));
  logger.info(
    `${toFetch.length} messages to fetch (${alreadyFetched.size} already fetched)`,
  );

  // Track thread messages for thread views
  const threadMessages = new Map<string, GogMessageFull[]>();

  // Fetch messages in batches with concurrency
  for (let i = 0; i < toFetch.length; i += FETCH_CONCURRENCY) {
    throwIfAborted(signal);

    const batch = toFetch.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((id) =>
        withRetry(() => cli.getMessage(id), {
          maxRetries: 4,
          retryOn: (err) => isRateLimitError(err),
        }),
      ),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j]!;
      const msgId = batch[j]!;

      if (result.status === "fulfilled") {
        const msg = result.value;
        try {
          await writeMessage(writer, msg, labelMap);

          // Download attachments
          const attachments = findAttachments(msg);
          for (const att of attachments) {
            try {
              const data = await cli.getAttachment(msgId, att.attachmentId);
              await writer.writeBinary(
                `attachments/${msgId}/${att.filename}`,
                data,
              );
            } catch (err) {
              logger.warn(`Failed to download attachment ${att.filename}`, {
                error: errorMessage(err),
              });
            }
          }

          // Track for thread view
          const threadId = msg.message.threadId;
          if (!threadMessages.has(threadId)) {
            threadMessages.set(threadId, []);
          }
          threadMessages.get(threadId)?.push(msg);

          // Track highest historyId
          if (!highestHistoryId || msg.message.historyId > highestHistoryId) {
            highestHistoryId = msg.message.historyId;
          }

          metadata.fetchedMessageIds.push(msgId);
          synced++;
        } catch (err) {
          failed++;
          errors.push({
            entity: `message:${msgId}`,
            error: errorMessage(err),
            retryable: true,
          });
        }
      } else {
        failed++;
        errors.push({
          entity: `message:${msgId}`,
          error: errorMessage(result.reason),
          retryable: true,
        });
      }
    }

    // Pace to avoid Gmail API rate limits
    await sleep(CALL_DELAY_MS);

    // Log progress
    const done = Math.min(i + FETCH_CONCURRENCY, toFetch.length);
    if (done % 50 === 0 || done === toFetch.length) {
      logger.progress(
        synced + alreadyFetched.size,
        allMessageIds.length,
        "Messages",
      );
    }

    // Checkpoint periodically
    if (done % 100 === 0) {
      metadata.totalMessagesFetched = synced + alreadyFetched.size;
    }
  }

  // Phase 3: Build thread views
  logger.info(`Building thread views for ${threadMessages.size} threads...`);
  for (const [threadId, messages] of threadMessages) {
    try {
      await writeThreadView(writer, threadId, messages, labelMap);
    } catch (err) {
      logger.warn(`Failed to write thread view ${threadId}`, {
        error: errorMessage(err),
      });
    }
  }

  // Record historyId for future incremental syncs
  if (highestHistoryId) {
    metadata.historyId = highestHistoryId;
  }

  metadata.totalMessagesFetched = synced + alreadyFetched.size;
  metadata.lastFullSyncAt = new Date().toISOString();

  return { synced, failed, errors };
}

// ─── Incremental Sync ───

async function incrementalSync(
  cli: GogCli,
  writer: OutputWriter,
  labelMap: Map<string, string>,
  metadata: GogSyncMetadata,
  logger: Logger,
  signal: AbortSignal,
): Promise<SyncBatchResult> {
  const errors: SyncError[] = [];
  let synced = 0;
  let failed = 0;

  if (!metadata.historyId) {
    logger.warn("No historyId — falling back to full sync");
    return fullSync(cli, writer, labelMap, metadata, logger, signal);
  }

  logger.info(`Incremental sync from historyId ${metadata.historyId}`);

  // Collect changed message IDs from history
  const addedIds = new Set<string>();
  const deletedIds = new Set<string>();
  let pageToken: string | undefined;
  let newHistoryId: string | null = null;

  try {
    do {
      throwIfAborted(signal);

      const result = await withRetry(
        () => cli.getHistory(metadata.historyId!, 100, pageToken),
        { maxRetries: 2 },
      );

      if (result.historyId) {
        newHistoryId = result.historyId;
      }

      for (const record of result.history ?? []) {
        const added = record.messagesAdded as
          | Array<{ message: { id: string } }>
          | undefined;
        const deleted = record.messagesDeleted as
          | Array<{ message: { id: string } }>
          | undefined;

        for (const item of added ?? []) {
          addedIds.add(item.message.id);
        }
        for (const item of deleted ?? []) {
          deletedIds.add(item.message.id);
        }
      }

      pageToken = result.nextPageToken;
    } while (pageToken);
  } catch (err) {
    const msg = errorMessage(err);
    if (msg.includes("404") || msg.includes("historyId")) {
      logger.warn("History expired — falling back to full sync");
      metadata.historyId = null;
      return fullSync(cli, writer, labelMap, metadata, logger, signal);
    }
    throw err;
  }

  logger.info(`History: ${addedIds.size} added, ${deletedIds.size} deleted`);

  // Fetch added/changed messages
  for (const msgId of addedIds) {
    throwIfAborted(signal);

    if (deletedIds.has(msgId)) continue; // Added then deleted — skip

    try {
      const msg = await withRetry(() => cli.getMessage(msgId), {
        maxRetries: 2,
      });
      await writeMessage(writer, msg, labelMap);

      // Download attachments
      const attachments = findAttachments(msg);
      for (const att of attachments) {
        try {
          const data = await cli.getAttachment(msgId, att.attachmentId);
          await writer.writeBinary(
            `attachments/${msgId}/${att.filename}`,
            data,
          );
        } catch (err) {
          logger.warn(`Failed to download attachment ${att.filename}`, {
            error: errorMessage(err),
          });
        }
      }

      synced++;
    } catch (err) {
      failed++;
      errors.push({
        entity: `message:${msgId}`,
        error: errorMessage(err),
        retryable: true,
      });
    }
  }

  // Remove deleted messages
  for (const msgId of deletedIds) {
    if (addedIds.has(msgId)) continue;

    try {
      await removeMessage(writer, msgId);
    } catch {
      // Ignore — file might not exist locally
    }
  }

  // Update historyId
  if (newHistoryId) {
    metadata.historyId = newHistoryId;
  }

  return { synced, failed, errors };
}

// ─── Attachment Discovery ───

interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

function findAttachments(msg: GogMessageFull): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];

  function walkParts(parts: GogMimePart[] | undefined): void {
    if (!parts) return;
    for (const part of parts) {
      if (part.body.attachmentId && part.filename) {
        attachments.push({
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType,
          size: part.body.size,
        });
      }
      if (part.parts) walkParts(part.parts);
    }
  }

  walkParts(msg.message.payload.parts);
  return attachments;
}

// ─── Metadata Helpers ───

function loadMetadata(raw: Record<string, unknown>): GogSyncMetadata {
  return {
    historyId: (raw.historyId as string) ?? null,
    emailAddress: (raw.emailAddress as string) ?? "",
    totalMessages: (raw.totalMessages as number) ?? 0,
    totalMessagesFetched: (raw.totalMessagesFetched as number) ?? 0,
    lastFullSyncAt: (raw.lastFullSyncAt as string) ?? null,
    fetchedMessageIds: (raw.fetchedMessageIds as string[]) ?? [],
  };
}

function saveMetadata(
  state: { metadata: Record<string, unknown> },
  metadata: GogSyncMetadata,
): void {
  state.metadata = {
    historyId: metadata.historyId,
    emailAddress: metadata.emailAddress,
    totalMessages: metadata.totalMessages,
    totalMessagesFetched: metadata.totalMessagesFetched,
    lastFullSyncAt: metadata.lastFullSyncAt,
    fetchedMessageIds: metadata.fetchedMessageIds,
  };
}

// ─── Error Helpers ───

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isRateLimitError(err: unknown): boolean {
  const msg = errorMessage(err);
  return (
    msg.includes("rateLimitExceeded") ||
    msg.includes("429") ||
    msg.includes("Quota exceeded")
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Sync aborted");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
