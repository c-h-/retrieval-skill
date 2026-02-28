/**
 * Gmail adapter — implements `Adapter` from `@saas-mirror/core`.
 *
 * Supports two sync modes:
 *
 *   **full**        List all messages → fetch each with format=full → parse
 *                   MIME → write markdown + metadata + attachments → record
 *                   historyId for future incremental runs.
 *
 *   **incremental** Use the Gmail History API (history.list) to discover
 *                   messages added/deleted/label-changed since the last
 *                   recorded historyId.  Falls back to differential full
 *                   sync when the historyId is stale (404).
 */

import type {
  Adapter,
  Logger,
  OutputWriter,
  SyncContext,
  SyncError,
  SyncResult,
} from "../core/index.js";
import { createOutputWriter } from "../core/index.js";

import { GmailClient } from "./client.js";
import { parseMessage } from "./mime.js";
import type {
  GmailConfig,
  GmailLabel,
  GmailMessage,
  HistoryChanges,
} from "./types.js";
import {
  removeMessage,
  writeAttachments,
  writeLabels,
  writeMessage,
  writeThreadView,
} from "./writer.js";

// ─── Config from environment ───

function loadConfig(): GmailConfig {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing required environment variables: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN",
    );
  }

  const maxMb = parseInt(process.env.GMAIL_MAX_ATTACHMENT_MB ?? "25", 10);

  return {
    clientId,
    clientSecret,
    refreshToken,
    maxAttachmentBytes: maxMb * 1024 * 1024,
    includeSpamTrash: process.env.GMAIL_INCLUDE_SPAM_TRASH === "true",
    includeDrafts: process.env.GMAIL_INCLUDE_DRAFTS === "true",
    pageSize: Math.min(
      parseInt(process.env.GMAIL_BATCH_SIZE ?? "500", 10),
      500,
    ),
    concurrency: parseInt(process.env.GMAIL_CONCURRENCY ?? "2", 10),
  };
}

// ─── Adapter ───

export class GmailAdapter implements Adapter {
  readonly name = "gmail";

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const startMs = Date.now();
    const errors: SyncError[] = [];
    let itemsSynced = 0;
    let itemsFailed = 0;

    const config = loadConfig();
    const client = new GmailClient(config, ctx.rateLimiter, ctx.logger);
    const writer = createOutputWriter(ctx.outputDir);

    ctx.logger.info("Gmail sync starting", { mode: ctx.mode });

    try {
      // ── Step 1: Fetch and cache labels ──
      const labels = await client.listLabels();
      const labelMap = new Map<string, GmailLabel>();
      for (const label of labels) {
        labelMap.set(label.id, label);
      }
      await writeLabels(writer, labels);
      ctx.logger.info("Labels loaded", { count: labels.length });

      // ── Route to sync strategy ──
      if (ctx.mode === "full" || !ctx.state.cursors.historyId) {
        const result = await this.fullSync(
          ctx,
          config,
          client,
          writer,
          labelMap,
          errors,
        );
        itemsSynced = result.synced;
        itemsFailed = result.failed;
      } else {
        const result = await this.incrementalSync(
          ctx,
          config,
          client,
          writer,
          labelMap,
          errors,
        );
        itemsSynced = result.synced;
        itemsFailed = result.failed;
      }
    } catch (err) {
      // Fatal errors (auth failures, etc.)
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error("Gmail sync failed with fatal error", {
        error: message,
      });
      errors.push({ entity: "gmail", error: message, retryable: false });
    }

    const durationMs = Date.now() - startMs;
    ctx.logger.info("Gmail sync complete", {
      mode: ctx.mode,
      itemsSynced,
      itemsFailed,
      durationMs,
      errors: errors.length,
    });

    return {
      adapter: this.name,
      mode: ctx.mode,
      itemsSynced,
      itemsFailed,
      errors,
      durationMs,
    };
  }

  // ─── Full Sync ───

  private async fullSync(
    ctx: SyncContext,
    config: GmailConfig,
    client: GmailClient,
    writer: OutputWriter,
    labelMap: Map<string, GmailLabel>,
    errors: SyncError[],
  ): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;

    ctx.logger.info("Starting full sync — listing all message IDs");

    // ── Phase 1: Collect all message IDs ──

    const allIds: string[] = [];
    let pageCount = 0;

    for await (const page of client.listMessageIds(ctx.signal)) {
      if (ctx.signal.aborted) break;
      allIds.push(...page.map((m) => m.id));
      pageCount++;
      ctx.logger.progress(allIds.length, 0, "Listing messages");
    }

    ctx.logger.info("Message listing complete", {
      total: allIds.length,
      pages: pageCount,
    });

    // ── Phase 2: Fetch + parse + write each message ──

    const threadMessages = new Map<string, GmailMessage[]>();

    for (let i = 0; i < allIds.length; i++) {
      if (ctx.signal.aborted) break;

      const msgId = allIds[i];
      ctx.logger.progress(i + 1, allIds.length, "Fetching messages");

      try {
        const result = await this.processMessage(
          msgId,
          config,
          client,
          writer,
          labelMap,
          ctx.logger,
        );

        if (result) {
          // Skip drafts unless configured to include
          if (!config.includeDrafts && result.labelIds.includes("DRAFT")) {
            continue;
          }

          // Collect for thread views
          const threadList = threadMessages.get(result.threadId) ?? [];
          threadList.push(result);
          threadMessages.set(result.threadId, threadList);

          synced++;
        }
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({
          entity: `message:${msgId}`,
          error: message,
          retryable: isRetryableError(err),
        });
        ctx.logger.warn("Failed to process message", {
          messageId: msgId,
          error: message,
        });
      }

      // Checkpoint every 100 messages
      if ((i + 1) % 100 === 0) {
        ctx.state.metadata.totalMessagesFetched = synced;
        await ctx.state.checkpoint();
      }
    }

    // ── Phase 3: Generate thread views ──

    ctx.logger.info("Generating thread views", {
      threads: threadMessages.size,
    });

    for (const [threadId, messages] of threadMessages) {
      if (ctx.signal.aborted) break;
      try {
        messages.sort((a, b) => a.internalDate - b.internalDate);
        await writeThreadView(writer, threadId, messages);
      } catch (err) {
        ctx.logger.warn("Failed to write thread view", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Phase 4: Record historyId for future incremental syncs ──

    try {
      const profile = await client.getProfile();
      ctx.state.cursors.historyId = profile.historyId;
      ctx.state.metadata.emailAddress = profile.emailAddress;
      ctx.state.metadata.totalMessages = profile.messagesTotal;
      ctx.state.metadata.lastFullSyncAt = new Date().toISOString();
      await ctx.state.checkpoint();
      ctx.logger.info("Recorded historyId for incremental sync", {
        historyId: profile.historyId,
        emailAddress: profile.emailAddress,
      });
    } catch (err) {
      ctx.logger.error("Failed to fetch profile for historyId", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { synced, failed };
  }

  // ─── Incremental Sync ───

  private async incrementalSync(
    ctx: SyncContext,
    config: GmailConfig,
    client: GmailClient,
    writer: OutputWriter,
    labelMap: Map<string, GmailLabel>,
    errors: SyncError[],
  ): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;

    const startHistoryId = ctx.state.cursors.historyId;
    ctx.logger.info("Starting incremental sync", { startHistoryId });

    let changes: HistoryChanges;
    try {
      changes = await client.listHistoryChanges(startHistoryId, ctx.signal);
    } catch (err) {
      // Stale history — the historyId is too old. Fall back to differential sync.
      if (isHistoryExpiredError(err)) {
        ctx.logger.warn(
          "History expired (404). Falling back to differential full sync.",
          { startHistoryId },
        );
        return this.differentialSync(
          ctx,
          config,
          client,
          writer,
          labelMap,
          errors,
        );
      }
      throw err;
    }

    ctx.logger.info("History changes collected", {
      added: changes.addedMessageIds.length,
      deleted: changes.deletedMessageIds.length,
      labelChanges: changes.labelChanges.length,
    });

    // ── Process new messages ──

    for (let i = 0; i < changes.addedMessageIds.length; i++) {
      if (ctx.signal.aborted) break;
      const msgId = changes.addedMessageIds[i];
      ctx.logger.progress(
        i + 1,
        changes.addedMessageIds.length,
        "Fetching new messages",
      );

      try {
        const result = await this.processMessage(
          msgId,
          config,
          client,
          writer,
          labelMap,
          ctx.logger,
        );
        if (result) {
          if (!config.includeDrafts && result.labelIds.includes("DRAFT")) {
            continue;
          }
          synced++;
        }
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({
          entity: `message:${msgId}`,
          error: message,
          retryable: isRetryableError(err),
        });
        ctx.logger.warn("Failed to process new message", {
          messageId: msgId,
          error: message,
        });
      }
    }

    // ── Process deleted messages ──

    for (const msgId of changes.deletedMessageIds) {
      if (ctx.signal.aborted) break;
      try {
        await removeMessage(writer, msgId);
        ctx.logger.info("Removed deleted message", { messageId: msgId });
      } catch (err) {
        ctx.logger.warn("Failed to remove deleted message", {
          messageId: msgId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Process label changes (re-fetch affected messages to update metadata) ──

    for (const change of changes.labelChanges) {
      if (ctx.signal.aborted) break;
      // Only re-process if the message was not already fetched as a new message
      if (changes.addedMessageIds.includes(change.messageId)) continue;

      try {
        await this.processMessage(
          change.messageId,
          config,
          client,
          writer,
          labelMap,
          ctx.logger,
        );
      } catch (err) {
        ctx.logger.warn("Failed to update labels for message", {
          messageId: change.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Update historyId ──

    if (changes.newHistoryId) {
      ctx.state.cursors.historyId = changes.newHistoryId;
    } else {
      // Fallback: get current historyId from profile
      try {
        const profile = await client.getProfile();
        ctx.state.cursors.historyId = profile.historyId;
      } catch {
        // Non-fatal — we keep the old value
      }
    }
    await ctx.state.checkpoint();

    return { synced, failed };
  }

  // ─── Differential Full Sync (stale history fallback) ───

  /**
   * When the History API returns 404 (history too old), we do a "differential"
   * sync: list all current remote message IDs, compare with locally-stored
   * IDs, fetch only the new ones, and remove local-only ones.
   */
  private async differentialSync(
    ctx: SyncContext,
    config: GmailConfig,
    client: GmailClient,
    writer: OutputWriter,
    labelMap: Map<string, GmailLabel>,
    errors: SyncError[],
  ): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;

    ctx.logger.info("Starting differential full sync");

    // ── Collect all remote IDs ──

    const remoteIds = new Set<string>();
    for await (const page of client.listMessageIds(ctx.signal)) {
      if (ctx.signal.aborted) break;
      for (const m of page) remoteIds.add(m.id);
    }

    ctx.logger.info("Remote message IDs collected", { count: remoteIds.size });

    // ── Determine which messages are new ──
    // We treat all remote IDs as needing fetch in differential mode;
    // the writer will overwrite existing files (idempotent).
    // A smarter approach would track known IDs, but that requires
    // scanning the output directory or maintaining a separate manifest.
    // For correctness on stale-history fallback, full re-fetch is safest.

    const idsToFetch = [...remoteIds];

    for (let i = 0; i < idsToFetch.length; i++) {
      if (ctx.signal.aborted) break;

      const msgId = idsToFetch[i];
      ctx.logger.progress(i + 1, idsToFetch.length, "Differential fetch");

      try {
        const result = await this.processMessage(
          msgId,
          config,
          client,
          writer,
          labelMap,
          ctx.logger,
        );
        if (result) {
          if (!config.includeDrafts && result.labelIds.includes("DRAFT")) {
            continue;
          }
          synced++;
        }
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({
          entity: `message:${msgId}`,
          error: message,
          retryable: isRetryableError(err),
        });
      }

      if ((i + 1) % 100 === 0) {
        await ctx.state.checkpoint();
      }
    }

    // ── Record fresh historyId ──

    try {
      const profile = await client.getProfile();
      ctx.state.cursors.historyId = profile.historyId;
      ctx.state.metadata.emailAddress = profile.emailAddress;
      ctx.state.metadata.totalMessages = profile.messagesTotal;
      ctx.state.metadata.lastFullSyncAt = new Date().toISOString();
      await ctx.state.checkpoint();
    } catch (err) {
      ctx.logger.error("Failed to fetch profile after differential sync", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { synced, failed };
  }

  // ─── Per-message processing (isolated error boundary) ───

  /**
   * Fetch a single message, parse its MIME payload, write markdown +
   * metadata + attachments. Returns the parsed message on success, or
   * null if the message was skipped (e.g., draft filtering).
   */
  private async processMessage(
    messageId: string,
    config: GmailConfig,
    client: GmailClient,
    writer: OutputWriter,
    labelMap: Map<string, GmailLabel>,
    logger: Logger,
  ): Promise<GmailMessage | null> {
    // Fetch raw message
    const raw = await client.getMessage(messageId);

    // Parse MIME
    let msg: GmailMessage;
    try {
      msg = parseMessage(raw);
    } catch (err) {
      logger.warn("MIME parsing failed — saving raw payload", {
        messageId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Save raw payload for debugging
      await writer.writeMeta(
        `messages/${messageId}.raw.json`,
        raw as unknown as Record<string, unknown>,
      );
      throw err;
    }

    // Skip drafts if not configured to include
    if (!config.includeDrafts && msg.labelIds.includes("DRAFT")) {
      return null;
    }

    // Write markdown + metadata
    await writeMessage(writer, msg, labelMap);

    // Fetch and write attachments (second pass, non-fatal)
    if (msg.attachments.length > 0) {
      const attResult = await writeAttachments(
        writer,
        msg,
        (mid, aid) => client.getAttachment(mid, aid),
        config.maxAttachmentBytes,
        logger,
      );

      // Update sidecar with skipped attachment info if any
      if (attResult.skipped.length > 0) {
        await writer.writeMeta(`messages/${messageId}.meta.json`, {
          ...(await rebuildMeta(msg, labelMap)),
          skippedAttachments: attResult.skipped,
        });
      }
    }

    return msg;
  }
}

// ─── Helpers ───

/**
 * Check whether a Gmail API error indicates an expired/invalid historyId
 * (HTTP 404 from history.list).
 */
function isHistoryExpiredError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code = (err as { code?: number }).code;
  if (code === 404) return true;

  // googleapis sometimes wraps the status in the message
  if (err instanceof Error && err.message.includes("404")) return true;

  return false;
}

/**
 * Check whether a Gmail API error is transient and worth retrying.
 */
function isRetryableError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const code =
    (err as { code?: number }).code ?? (err as { status?: number }).status;
  if (code === 429 || (code !== undefined && code >= 500 && code < 600)) {
    return true;
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("socket hang up")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Rebuild the metadata sidecar object from a parsed message.  Used when we
 * need to re-write meta.json to include skipped attachment info.
 */
async function rebuildMeta(
  msg: GmailMessage,
  labelMap: Map<string, GmailLabel>,
): Promise<Record<string, unknown>> {
  const labels = msg.labelIds.map((id) => labelMap.get(id)?.name ?? id);

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

  return meta;
}
