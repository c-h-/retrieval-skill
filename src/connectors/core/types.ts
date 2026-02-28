/** Core type definitions for saas-mirror. */

// ─── Adapter Interface ───

export interface Adapter {
  name: string;
  sync(ctx: SyncContext): Promise<SyncResult>;
}

// ─── Sync Context (injected by engine) ───

export interface SyncContext {
  mode: "full" | "incremental";
  outputDir: string;
  state: AdapterState;
  rateLimiter: RateLimiter;
  logger: Logger;
  signal: AbortSignal;
}

// ─── Adapter State ───

export interface AdapterState {
  lastSyncAt: string | null;
  cursors: Record<string, string>;
  metadata: Record<string, unknown>;
  checkpoint(): Promise<void>;
}

// ─── Sync Result ───

export interface SyncResult {
  adapter: string;
  mode: "full" | "incremental";
  itemsSynced: number;
  itemsFailed: number;
  errors: SyncError[];
  durationMs: number;
}

export interface SyncError {
  entity: string;
  error: string;
  retryable: boolean;
}

// ─── Rate Limiter ───

export interface RateLimiterConfig {
  maxRequests?: number;
  windowMs?: number;
  minDelayMs?: number;
  maxUnitsPerWindow?: number;
  unitsWindowMs?: number;
}

export interface RateLimiter {
  acquire(cost?: number): Promise<void>;
  backoff(retryAfterMs: number): void;
  updateFromHeaders(headers: Record<string, string>): void;
}

// ─── Logger ───

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  progress(current: number, total: number, label: string): void;
}

// ─── Output Writer ───

export interface OutputWriter {
  writeDocument(
    relativePath: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): Promise<void>;
  writeMeta(relativePath: string, data: Record<string, unknown>): Promise<void>;
  writeJsonl(
    relativePath: string,
    records: Record<string, unknown>[],
  ): Promise<void>;
  appendJsonl(
    relativePath: string,
    records: Record<string, unknown>[],
  ): Promise<void>;
  writeBinary(relativePath: string, data: Buffer): Promise<void>;
  remove(relativePath: string): Promise<void>;
}

// ─── Engine Config ───

export interface SyncEngineConfig {
  outputDir: string;
  stateDir: string;
  adapters: AdapterRegistration[];
}

export interface AdapterRegistration {
  adapter: Adapter;
  rateLimiterConfig?: RateLimiterConfig;
}

// ─── Persisted State Shape ───

export interface PersistedState {
  lastSyncAt: string | null;
  cursors: Record<string, string>;
  metadata: Record<string, unknown>;
}
