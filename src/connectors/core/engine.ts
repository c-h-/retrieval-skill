import * as path from "node:path";
import { createLogger } from "./logger.js";
import { createOutputWriter } from "./output.js";
import { createRateLimiter } from "./rate-limiter.js";
import { StateManager } from "./state.js";
import type {
  AdapterRegistration,
  SyncContext,
  SyncEngineConfig,
  SyncResult,
} from "./types.js";

export class SyncEngine {
  private readonly config: SyncEngineConfig;

  constructor(config: SyncEngineConfig) {
    this.config = config;
  }

  async syncAll(mode: "full" | "incremental"): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const reg of this.config.adapters) {
      const result = await this.runAdapter(reg, mode);
      results.push(result);
    }
    return results;
  }

  async syncOne(
    adapterName: string,
    mode: "full" | "incremental",
  ): Promise<SyncResult> {
    const reg = this.config.adapters.find(
      (a) => a.adapter.name === adapterName,
    );
    if (!reg) {
      throw new Error(
        `Adapter "${adapterName}" not found. Available: ${this.config.adapters.map((a) => a.adapter.name).join(", ")}`,
      );
    }
    return this.runAdapter(reg, mode);
  }

  private async runAdapter(
    reg: AdapterRegistration,
    mode: "full" | "incremental",
  ): Promise<SyncResult> {
    const { adapter, rateLimiterConfig } = reg;
    const logger = createLogger(adapter.name);
    const outputDir = path.join(this.config.outputDir, adapter.name);
    const stateFile = path.join(
      this.config.stateDir,
      adapter.name,
      "_meta",
      "state.json",
    );

    const stateManager = new StateManager(stateFile);
    const adapterState = stateManager.getAdapterState();

    // If incremental but no prior state, fall back to full
    const effectiveMode =
      mode === "incremental" && !adapterState.lastSyncAt ? "full" : mode;

    const rateLimiter = createRateLimiter(rateLimiterConfig ?? {});
    const _outputWriter = createOutputWriter(outputDir);

    const ac = new AbortController();

    // Handle SIGINT gracefully
    const sigHandler = () => {
      logger.warn("Received interrupt, finishing current operation...");
      ac.abort();
    };
    process.on("SIGINT", sigHandler);

    const ctx: SyncContext = {
      mode: effectiveMode,
      outputDir,
      state: adapterState,
      rateLimiter,
      logger,
      signal: ac.signal,
    };

    logger.info(`Starting ${effectiveMode} sync`);
    const startTime = Date.now();

    let result: SyncResult;
    try {
      result = await adapter.sync(ctx);
      await stateManager.save();
      logger.info(
        `Sync complete: ${result.itemsSynced} items, ${result.itemsFailed} failed`,
        { durationMs: result.durationMs },
      );
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Sync failed: ${errorMsg}`);
      result = {
        adapter: adapter.name,
        mode: effectiveMode,
        itemsSynced: 0,
        itemsFailed: 0,
        errors: [{ entity: "sync", error: errorMsg, retryable: false }],
        durationMs,
      };
    } finally {
      process.removeListener("SIGINT", sigHandler);
    }

    return result;
  }

  listAdapters(): string[] {
    return this.config.adapters.map((a) => a.adapter.name);
  }
}
