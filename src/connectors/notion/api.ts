/**
 * Notion API wrapper.
 *
 * Thin wrapper around @notionhq/client that integrates with the core
 * rate-limiter, adds automatic retry for 429/5xx, and provides a
 * typed pagination helper used throughout the adapter.
 */

import { APIErrorCode, Client, isNotionClientError } from "@notionhq/client";
import type {
  GetDatabaseResponse,
  GetPageResponse,
  ListBlockChildrenResponse,
  ListCommentsResponse,
  ListUsersResponse,
  QueryDatabaseResponse,
  SearchParameters,
  SearchResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { Logger, RateLimiter } from "../core/index.js";
import type { BlockTree } from "./types.js";

// ─── Constants ───

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60_000;
const PAGE_SIZE = 100;
const MAX_BLOCK_DEPTH = 20;

// ─── Notion API Wrapper ───

export class NotionApi {
  private readonly client: Client;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  private readonly signal: AbortSignal;

  constructor(opts: {
    token: string;
    rateLimiter: RateLimiter;
    logger: Logger;
    signal: AbortSignal;
  }) {
    this.client = new Client({ auth: opts.token });
    this.rateLimiter = opts.rateLimiter;
    this.logger = opts.logger;
    this.signal = opts.signal;
  }

  // ─── Low-level: rate-limited + retried API call ───

  private async call<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      this.checkAbort();
      await this.rateLimiter.acquire();

      try {
        return await fn();
      } catch (err: unknown) {
        lastError = err;

        if (isNotionClientError(err)) {
          // 429 — rate limited
          if (err.code === APIErrorCode.RateLimited) {
            const retryAfterSec = this.extractRetryAfter(err);
            const delayMs = retryAfterSec
              ? retryAfterSec * 1_000
              : this.backoffDelay(attempt);
            this.logger.warn(
              `Rate limited on ${label}, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
            );
            this.rateLimiter.backoff(delayMs);
            await sleep(delayMs);
            continue;
          }

          // 5xx — server error, retryable
          if (this.isServerError(err)) {
            const delayMs = this.backoffDelay(attempt);
            this.logger.warn(
              `Server error on ${label} (${err.code}), retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
            );
            await sleep(delayMs);
            continue;
          }

          // 4xx non-429 — not retryable (e.g. 404, 403)
          throw err;
        }

        // Network errors — retryable
        if (isNetworkError(err)) {
          const delayMs = this.backoffDelay(attempt);
          this.logger.warn(
            `Network error on ${label}, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await sleep(delayMs);
          continue;
        }

        // Unknown error — don't retry
        throw err;
      }
    }

    throw lastError;
  }

  private backoffDelay(attempt: number): number {
    const delay = Math.min(
      BASE_RETRY_DELAY_MS * 2 ** attempt,
      MAX_RETRY_DELAY_MS,
    );
    return delay + delay * 0.1 * Math.random();
  }

  private extractRetryAfter(err: unknown): number | undefined {
    // The Notion client error may include headers with Retry-After
    const headers = (err as { headers?: Record<string, string> }).headers;
    if (headers?.["retry-after"]) {
      const val = parseFloat(headers["retry-after"]);
      if (!Number.isNaN(val)) return val;
    }
    return undefined;
  }

  private isServerError(err: unknown): boolean {
    if (isNotionClientError(err)) {
      return (
        err.code === APIErrorCode.ServiceUnavailable ||
        err.code === APIErrorCode.InternalServerError
      );
    }
    return false;
  }

  private checkAbort(): void {
    if (this.signal.aborted) {
      throw new Error("Sync aborted");
    }
  }

  // ─── Pagination helper ───

  async *paginate<T>(
    label: string,
    fn: (cursor?: string) => Promise<{
      results: T[];
      has_more: boolean;
      next_cursor: string | null;
    }>,
  ): AsyncGenerator<T> {
    let cursor: string | undefined;
    do {
      this.checkAbort();
      const response = await this.call(label, () => fn(cursor));
      for (const item of response.results) {
        yield item;
      }
      cursor =
        response.has_more && response.next_cursor
          ? response.next_cursor
          : undefined;
    } while (cursor);
  }

  // ─── Search (discover all pages + databases) ───

  async *search(opts?: {
    sort?: SearchParameters["sort"];
    filter?: SearchParameters["filter"];
    query?: string;
  }): AsyncGenerator<SearchResponse["results"][number]> {
    yield* this.paginate("search", async (cursor) => {
      const params: SearchParameters = {
        page_size: PAGE_SIZE,
        ...(cursor && { start_cursor: cursor }),
        ...(opts?.sort && { sort: opts.sort }),
        ...(opts?.filter && { filter: opts.filter }),
        ...(opts?.query && { query: opts.query }),
      };
      return await this.client.search(params);
    });
  }

  // ─── Search sorted by last_edited_time descending ───
  // Yields results and stops early if stopBefore returns true for an item.

  async *searchByLastEdited(
    stopBefore?: string,
  ): AsyncGenerator<SearchResponse["results"][number]> {
    for await (const item of this.search({
      sort: { direction: "descending", timestamp: "last_edited_time" },
    })) {
      const lastEdited =
        "last_edited_time" in item
          ? (item as { last_edited_time: string }).last_edited_time
          : null;
      if (stopBefore && lastEdited && lastEdited < stopBefore) {
        return; // All subsequent items are older — stop
      }
      yield item;
    }
  }

  // ─── Get page metadata ───

  async getPage(pageId: string): Promise<GetPageResponse> {
    return this.call(`getPage(${pageId})`, () =>
      this.client.pages.retrieve({ page_id: pageId }),
    );
  }

  // ─── Get database schema ───

  async getDatabase(dbId: string): Promise<GetDatabaseResponse> {
    return this.call(`getDatabase(${dbId})`, () =>
      this.client.databases.retrieve({ database_id: dbId }),
    );
  }

  // ─── Query database rows (pages) ───

  async *queryDatabase(
    dbId: string,
  ): AsyncGenerator<QueryDatabaseResponse["results"][number]> {
    yield* this.paginate(`queryDatabase(${dbId})`, async (cursor) => {
      return await this.client.databases.query({
        database_id: dbId,
        page_size: PAGE_SIZE,
        ...(cursor && { start_cursor: cursor }),
      });
    });
  }

  // ─── Get block children (single level) ───

  async getBlockChildren(
    blockId: string,
    startCursor?: string,
  ): Promise<ListBlockChildrenResponse> {
    return this.call(`getBlockChildren(${blockId})`, () =>
      this.client.blocks.children.list({
        block_id: blockId,
        page_size: PAGE_SIZE,
        ...(startCursor && { start_cursor: startCursor }),
      }),
    );
  }

  // ─── Fetch full block tree recursively ───

  async fetchBlockTree(
    blockId: string,
    depth = 0,
    visited = new Set<string>(),
  ): Promise<BlockTree[]> {
    if (depth > MAX_BLOCK_DEPTH) {
      this.logger.warn(
        `Max block depth ${MAX_BLOCK_DEPTH} exceeded for block ${blockId}`,
      );
      return [];
    }
    if (visited.has(blockId)) {
      this.logger.warn(`Cycle detected at block ${blockId}, skipping`);
      return [];
    }
    visited.add(blockId);

    const blocks: BlockTree[] = [];

    for await (const block of this.paginate(
      `blocks(${blockId})`,
      async (cursor) => {
        return await this.client.blocks.children.list({
          block_id: blockId,
          page_size: PAGE_SIZE,
          ...(cursor && { start_cursor: cursor }),
        });
      },
    )) {
      this.checkAbort();
      const b = block as Record<string, unknown>;
      const blockType = b.type as string;
      const typeContent = (b[blockType] ?? {}) as Record<string, unknown>;

      const node: BlockTree = {
        id: b.id as string,
        type: blockType,
        hasChildren: b.has_children as boolean,
        children: [],
        content: typeContent,
        parentId: blockId,
      };

      // Recursively fetch children — but skip child_page and child_database
      // blocks, which are synced separately by the tree walker
      if (
        node.hasChildren &&
        blockType !== "child_page" &&
        blockType !== "child_database"
      ) {
        // For synced_block references, fetch from the original block
        if (blockType === "synced_block" && typeContent.synced_from) {
          const syncedFrom = typeContent.synced_from as {
            block_id: string;
          } | null;
          if (syncedFrom?.block_id) {
            try {
              node.children = await this.fetchBlockTree(
                syncedFrom.block_id,
                depth + 1,
                visited,
              );
            } catch (err) {
              this.logger.warn(
                `Could not fetch synced block ${syncedFrom.block_id}: ${String(err)}`,
              );
            }
          }
        } else {
          node.children = await this.fetchBlockTree(
            b.id as string,
            depth + 1,
            visited,
          );
        }
      }

      blocks.push(node);
    }

    return blocks;
  }

  // ─── List users ───

  async *listUsers(): AsyncGenerator<ListUsersResponse["results"][number]> {
    yield* this.paginate("listUsers", async (cursor) => {
      return await this.client.users.list({
        page_size: PAGE_SIZE,
        ...(cursor && { start_cursor: cursor }),
      });
    });
  }

  // ─── List comments for a block or page ───

  async *listComments(
    blockId: string,
  ): AsyncGenerator<ListCommentsResponse["results"][number]> {
    yield* this.paginate(`listComments(${blockId})`, async (cursor) => {
      return await this.client.comments.list({
        block_id: blockId,
        page_size: PAGE_SIZE,
        ...(cursor && { start_cursor: cursor }),
      });
    });
  }

  // ─── Download file from URL (for expiring Notion-hosted files) ───

  async downloadFile(url: string): Promise<Buffer> {
    await this.rateLimiter.acquire();
    const response = await fetch(url, { signal: this.signal });
    if (!response.ok) {
      throw new Error(
        `Failed to download file: ${response.status} ${response.statusText}`,
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("enotfound") ||
      msg.includes("socket hang up") ||
      msg.includes("fetch failed")
    );
  }
  return false;
}
