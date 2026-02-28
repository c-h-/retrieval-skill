/**
 * GraphQL client for the Linear API with rate limiting, retry, and pagination.
 */

import type { Logger, RateLimiter } from "../core/index.js";
import { withRetry } from "../core/index.js";
import { GraphQLClient } from "graphql-request";
import type { PaginatedResponse } from "./types.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

/** Thresholds for pre-emptive rate limit pausing. */
const REQUEST_REMAINING_THRESHOLD = 200;
const COMPLEXITY_REMAINING_THRESHOLD = 50_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const _MIN_DELAY_BETWEEN_REQUESTS_MS = 50;

export interface LinearGraphQLClientOptions {
  apiKey: string;
  rateLimiter: RateLimiter;
  logger: Logger;
  signal: AbortSignal;
}

export class LinearGraphQLClient {
  private readonly client: GraphQLClient;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  private readonly signal: AbortSignal;

  constructor(opts: LinearGraphQLClientOptions) {
    this.rateLimiter = opts.rateLimiter;
    this.logger = opts.logger;
    this.signal = opts.signal;

    this.client = new GraphQLClient(LINEAR_API_URL, {
      headers: {
        Authorization: opts.apiKey,
        "Content-Type": "application/json",
      },
      signal: opts.signal,
    });
  }

  /**
   * Execute a GraphQL query with rate limiting and retry logic.
   */
  async request<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    this.checkAbort();

    // Acquire rate limiter slot (min delay enforced by core rate limiter)
    await this.rateLimiter.acquire();

    return withRetry(
      async () => {
        this.checkAbort();

        const response = await this.client.rawRequest<T>(query, variables);

        // Update rate limiter from response headers
        this.processRateLimitHeaders(response.headers);

        return response.data;
      },
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        maxDelayMs: 60_000,
        retryOn: (err: unknown) => this.isRetryable(err),
      },
    );
  }

  /**
   * Paginate through a collection, accumulating all nodes.
   * The `extractor` function pulls the PaginatedResponse from the query result.
   */
  async paginate<TResult, TNode>(
    query: string,
    variables: Record<string, unknown>,
    extractor: (result: TResult) => PaginatedResponse<TNode>,
  ): Promise<TNode[]> {
    const allNodes: TNode[] = [];
    let cursor: string | undefined;

    do {
      this.checkAbort();
      const vars = { ...variables, after: cursor ?? null };
      const result = await this.request<TResult>(query, vars);
      const page = extractor(result);
      allNodes.push(...page.nodes);

      cursor =
        page.pageInfo.hasNextPage && page.pageInfo.endCursor
          ? page.pageInfo.endCursor
          : undefined;
    } while (cursor);

    return allNodes;
  }

  /**
   * Paginate through a collection, invoking a callback per page.
   * Useful for large collections where you want to process as you go.
   */
  async paginateWithCallback<TResult, TNode>(
    query: string,
    variables: Record<string, unknown>,
    extractor: (result: TResult) => PaginatedResponse<TNode>,
    onPage: (nodes: TNode[]) => Promise<void>,
  ): Promise<number> {
    let totalNodes = 0;
    let cursor: string | undefined;

    do {
      this.checkAbort();
      const vars = { ...variables, after: cursor ?? null };
      const result = await this.request<TResult>(query, vars);
      const page = extractor(result);

      if (page.nodes.length > 0) {
        await onPage(page.nodes);
        totalNodes += page.nodes.length;
      }

      cursor =
        page.pageInfo.hasNextPage && page.pageInfo.endCursor
          ? page.pageInfo.endCursor
          : undefined;
    } while (cursor);

    return totalNodes;
  }

  /**
   * Download a binary file from a URL. Returns null on failure.
   */
  async downloadBinary(url: string): Promise<Buffer | null> {
    this.checkAbort();

    try {
      const response = await fetch(url, { signal: this.signal });
      if (!response.ok) {
        this.logger.warn(
          `Failed to download attachment: HTTP ${response.status}`,
          { url },
        );
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to download attachment: ${message}`, { url });
      return null;
    }
  }

  private processRateLimitHeaders(headers: Headers): void {
    const headerMap: Record<string, string> = {};

    // Extract rate limit headers
    const requestsRemaining = headers.get("x-ratelimit-requests-remaining");
    const requestsReset = headers.get("x-ratelimit-requests-reset");
    const complexityRemaining = headers.get("x-ratelimit-complexity-remaining");
    const complexityReset = headers.get("x-ratelimit-complexity-reset");

    if (requestsRemaining)
      headerMap["x-ratelimit-requests-remaining"] = requestsRemaining;
    if (requestsReset) headerMap["x-ratelimit-requests-reset"] = requestsReset;
    if (complexityRemaining)
      headerMap["x-ratelimit-complexity-remaining"] = complexityRemaining;
    if (complexityReset)
      headerMap["x-ratelimit-complexity-reset"] = complexityReset;

    this.rateLimiter.updateFromHeaders(headerMap);

    // Pre-emptive pausing for request budget
    if (requestsRemaining) {
      const remaining = parseInt(requestsRemaining, 10);
      if (remaining < REQUEST_REMAINING_THRESHOLD && requestsReset) {
        const resetMs = parseResetTimestamp(requestsReset);
        if (resetMs > 0) {
          this.logger.warn(
            `Request rate limit low (${remaining} remaining), pausing`,
            {
              resetInMs: resetMs,
            },
          );
          this.rateLimiter.backoff(resetMs);
        }
      }
    }

    // Pre-emptive pausing for complexity budget
    if (complexityRemaining) {
      const remaining = parseInt(complexityRemaining, 10);
      if (remaining < COMPLEXITY_REMAINING_THRESHOLD && complexityReset) {
        const resetMs = parseResetTimestamp(complexityReset);
        if (resetMs > 0) {
          this.logger.warn(
            `Complexity rate limit low (${remaining} remaining), pausing`,
            {
              resetInMs: resetMs,
            },
          );
          this.rateLimiter.backoff(resetMs);
        }
      }
    }
  }

  private isRetryable(err: unknown): boolean {
    // HTTP 429 - rate limited
    if (isHttpError(err, 429)) {
      const retryAfter = getRetryAfterMs(err);
      this.rateLimiter.backoff(retryAfter);
      this.logger.warn(`Rate limited (429), backing off ${retryAfter}ms`);
      return true;
    }

    // Server errors (5xx)
    if (
      isHttpError(err, 500) ||
      isHttpError(err, 502) ||
      isHttpError(err, 503) ||
      isHttpError(err, 504)
    ) {
      return true;
    }

    // Network errors
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

  private checkAbort(): void {
    if (this.signal.aborted) {
      throw new Error("Sync aborted");
    }
  }
}

// ─── Helpers ───

function isHttpError(err: unknown, status: number): boolean {
  const errObj = err as { response?: { status?: number }; status?: number };
  return errObj?.response?.status === status || errObj?.status === status;
}

function getRetryAfterMs(err: unknown): number {
  const errObj = err as {
    response?: { headers?: { get?: (k: string) => string | null } };
  };
  const retryAfter = errObj?.response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function parseResetTimestamp(reset: string): number {
  const val = parseInt(reset, 10);
  if (Number.isNaN(val)) return 0;
  // If small number, treat as seconds from now; if epoch, compute delta
  const epochMs = val < 1e12 ? val * 1000 : val;
  const delta = epochMs - Date.now();
  return delta > 0 ? delta : 0;
}
