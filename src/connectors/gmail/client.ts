/**
 * Gmail API client wrapper.
 *
 * Thin layer over `googleapis` that exposes typed helpers for the operations
 * the adapter needs:  list messages, get message, get attachment, list
 * history, list labels, and get profile.
 *
 * Every public method acquires a rate-limiter token before calling the API so
 * the adapter never has to think about quota management.
 */

import type { Logger, RateLimiter } from "../core/index.js";
import { withRetry } from "../core/index.js";
import { type gmail_v1, google } from "googleapis";
import type {
  GmailConfig,
  GmailLabel,
  HistoryChanges,
  LabelChange,
} from "./types.js";

// ─── Quota costs (units per call) ───

const COST_LIST_MESSAGES = 5;
const COST_GET_MESSAGE = 5;
const COST_GET_ATTACHMENT = 5;
const COST_LIST_HISTORY = 2;
const COST_LIST_LABELS = 1;
const COST_GET_PROFILE = 5;

// ─── Retry predicate for Gmail API errors ───

function isRetryableGmailError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;

  const status =
    (err as { code?: number; status?: number }).code ??
    (err as { code?: number; status?: number }).status;

  // 429 Too Many Requests, 5xx Server Errors
  if (
    status === 429 ||
    (status !== undefined && status >= 500 && status < 600)
  ) {
    return true;
  }

  // Network-level transient errors
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("enotfound") ||
      msg.includes("socket hang up") ||
      msg.includes("fetch failed")
    ) {
      return true;
    }
  }

  return false;
}

// ─── Client ───

export class GmailClient {
  private readonly gmail: gmail_v1.Gmail;
  private readonly rateLimiter: RateLimiter;
  private readonly config: GmailConfig;

  constructor(config: GmailConfig, rateLimiter: RateLimiter, _logger: Logger) {
    this.config = config;
    this.rateLimiter = rateLimiter;

    const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    auth.setCredentials({ refresh_token: config.refreshToken });
    this.gmail = google.gmail({ version: "v1", auth });
  }

  // ── Labels ──

  async listLabels(): Promise<GmailLabel[]> {
    await this.rateLimiter.acquire(COST_LIST_LABELS);
    const res = await withRetry(
      () => this.gmail.users.labels.list({ userId: "me" }),
      { retryOn: isRetryableGmailError },
    );

    return (res.data.labels ?? []).map((l) => ({
      id: l.id!,
      name: l.name!,
      type: (l.type === "system" ? "system" : "user") as "system" | "user",
    }));
  }

  // ── Messages ──

  /**
   * List all message IDs (paginated).  Returns an async generator that yields
   * pages of `{ id, threadId }` stubs.
   */
  async *listMessageIds(
    signal: AbortSignal,
  ): AsyncGenerator<Array<{ id: string; threadId: string }>> {
    let pageToken: string | undefined;

    do {
      if (signal.aborted) return;

      await this.rateLimiter.acquire(COST_LIST_MESSAGES);

      const res = await withRetry(
        () =>
          this.gmail.users.messages.list({
            userId: "me",
            maxResults: this.config.pageSize,
            includeSpamTrash: this.config.includeSpamTrash,
            pageToken,
          }),
        { retryOn: isRetryableGmailError },
      );

      const messages = (res.data.messages ?? []).map((m) => ({
        id: m.id!,
        threadId: m.threadId!,
      }));

      if (messages.length > 0) {
        yield messages;
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  /**
   * Fetch a single message with `format=full`.
   */
  async getMessage(messageId: string): Promise<gmail_v1.Schema$Message> {
    await this.rateLimiter.acquire(COST_GET_MESSAGE);
    const res = await withRetry(
      () =>
        this.gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "full",
        }),
      { retryOn: isRetryableGmailError },
    );
    return res.data;
  }

  // ── Attachments ──

  /**
   * Fetch the raw bytes of an attachment. Returns a Buffer.
   */
  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    await this.rateLimiter.acquire(COST_GET_ATTACHMENT);
    const res = await withRetry(
      () =>
        this.gmail.users.messages.attachments.get({
          userId: "me",
          messageId,
          id: attachmentId,
        }),
      { retryOn: isRetryableGmailError },
    );

    const data = res.data.data;
    if (!data) {
      throw new Error(
        `Empty attachment data for message=${messageId} attachment=${attachmentId}`,
      );
    }
    return Buffer.from(data, "base64url");
  }

  // ── History (incremental sync) ──

  /**
   * Walk the History API from `startHistoryId` and collect all changes.
   *
   * Throws with `.code === 404` when the startHistoryId is too old —
   * the caller should fall back to a differential full sync.
   */
  async listHistoryChanges(
    startHistoryId: string,
    signal: AbortSignal,
  ): Promise<HistoryChanges> {
    const addedIds = new Set<string>();
    const deletedIds = new Set<string>();
    const labelMap = new Map<string, LabelChange>();
    let newestHistoryId: string | null = null;

    let pageToken: string | undefined;

    do {
      if (signal.aborted) {
        break;
      }

      await this.rateLimiter.acquire(COST_LIST_HISTORY);

      const res = await withRetry(
        () =>
          this.gmail.users.history.list({
            userId: "me",
            startHistoryId,
            historyTypes: [
              "messageAdded",
              "messageDeleted",
              "labelAdded",
              "labelRemoved",
            ],
            maxResults: 500,
            pageToken,
          }),
        { retryOn: isRetryableGmailError },
      );

      newestHistoryId = res.data.historyId ?? newestHistoryId;

      for (const record of res.data.history ?? []) {
        // Messages added
        for (const added of record.messagesAdded ?? []) {
          if (added.message?.id) {
            addedIds.add(added.message.id);
          }
        }

        // Messages deleted
        for (const deleted of record.messagesDeleted ?? []) {
          if (deleted.message?.id) {
            deletedIds.add(deleted.message.id);
          }
        }

        // Label additions
        for (const lbl of record.labelsAdded ?? []) {
          if (lbl.message?.id && lbl.labelIds) {
            const existing = labelMap.get(lbl.message.id) ?? {
              messageId: lbl.message.id,
              addedLabelIds: [],
              removedLabelIds: [],
            };
            existing.addedLabelIds.push(...lbl.labelIds);
            labelMap.set(lbl.message.id, existing);
          }
        }

        // Label removals
        for (const lbl of record.labelsRemoved ?? []) {
          if (lbl.message?.id && lbl.labelIds) {
            const existing = labelMap.get(lbl.message.id) ?? {
              messageId: lbl.message.id,
              addedLabelIds: [],
              removedLabelIds: [],
            };
            existing.removedLabelIds.push(...lbl.labelIds);
            labelMap.set(lbl.message.id, existing);
          }
        }
      }

      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    // A message that was both added and deleted can be discarded from both
    for (const id of deletedIds) {
      addedIds.delete(id);
    }

    return {
      addedMessageIds: [...addedIds],
      deletedMessageIds: [...deletedIds],
      labelChanges: [...labelMap.values()],
      newHistoryId: newestHistoryId,
    };
  }

  // ── Profile ──

  async getProfile(): Promise<{
    emailAddress: string;
    historyId: string;
    messagesTotal: number;
  }> {
    await this.rateLimiter.acquire(COST_GET_PROFILE);
    const res = await withRetry(
      () => this.gmail.users.getProfile({ userId: "me" }),
      { retryOn: isRetryableGmailError },
    );
    return {
      emailAddress: res.data.emailAddress!,
      historyId: res.data.historyId!,
      messagesTotal: res.data.messagesTotal ?? 0,
    };
  }
}
