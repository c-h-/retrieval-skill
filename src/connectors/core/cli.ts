#!/usr/bin/env node
import { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import { SyncEngine } from "./engine.js";
import type { AdapterRegistration, SyncResult } from "./types.js";

loadDotenv();
loadDotenv({ path: ".env.local", override: true });

async function loadAdapters(): Promise<AdapterRegistration[]> {
  const registrations: AdapterRegistration[] = [];

  // Try loading each adapter — skip if not installed
  try {
    const { SlackAdapter } = await import("../slack/index.js");
    if (process.env.SLACK_BOT_TOKEN) {
      registrations.push({
        adapter: new SlackAdapter(),
        rateLimiterConfig: {
          minDelayMs: 600,
          maxRequests: 50,
          windowMs: 60_000,
        },
      });
    }
  } catch {
    /* adapter not installed */
  }

  try {
    const { NotionAdapter } = await import("../notion/index.js");
    if (process.env.NOTION_TOKEN) {
      registrations.push({
        adapter: new NotionAdapter(),
        rateLimiterConfig: { maxRequests: 3, windowMs: 1_000, minDelayMs: 200 },
      });
    }
  } catch {
    /* adapter not installed */
  }

  try {
    const { LinearAdapter } = await import("../linear/index.js");
    if (process.env.LINEAR_API_KEY) {
      registrations.push({
        adapter: new LinearAdapter(),
        rateLimiterConfig: {
          minDelayMs: 50,
          maxRequests: 4500,
          windowMs: 3_600_000,
        },
      });
    }
  } catch {
    /* adapter not installed */
  }

  try {
    const { GmailAdapter } = await import("../gmail/index.js");
    if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN) {
      registrations.push({
        adapter: new GmailAdapter(),
        rateLimiterConfig: { maxUnitsPerWindow: 14_000, unitsWindowMs: 60_000 },
      });
    }
  } catch {
    /* adapter not installed */
  }

  try {
    const { GogAdapter } = await import("../gog/index.js");
    if (process.env.GOG_ACCOUNT || process.env.GOG_PATH) {
      registrations.push({
        adapter: new GogAdapter(),
        rateLimiterConfig: { maxRequests: 20, windowMs: 1_000 },
      });
    }
  } catch {
    /* adapter not installed */
  }

  return registrations;
}

function printResults(results: SyncResult[]): void {
  console.log("\n═══ Sync Summary ═══\n");
  for (const r of results) {
    const status = r.errors.length === 0 ? "✓" : "⚠";
    console.log(
      `${status} ${r.adapter} (${r.mode}): ${r.itemsSynced} synced, ${r.itemsFailed} failed [${(r.durationMs / 1000).toFixed(1)}s]`,
    );
    for (const err of r.errors.slice(0, 5)) {
      console.log(`  ✗ ${err.entity}: ${err.error}`);
    }
    if (r.errors.length > 5) {
      console.log(`  ... and ${r.errors.length - 5} more errors`);
    }
  }
}

const program = new Command()
  .name("retrieve-mirror")
  .description("Mirror SaaS data locally for indexing and search")
  .version("1.0.0");

program
  .command("sync")
  .description("Sync data from configured adapters")
  .option("--full", "Run full hydration instead of incremental")
  .option("--adapter <name>", "Sync a specific adapter only")
  .option("--output <dir>", "Output directory", "./data")
  .action(async (opts) => {
    const mode = opts.full ? "full" : "incremental";
    const outputDir = opts.output;
    const adapters = await loadAdapters();

    if (adapters.length === 0) {
      console.error(
        "No adapters configured. Set API credentials in .env file.",
      );
      console.error("See .env.example for required variables.");
      process.exit(1);
    }

    const engine = new SyncEngine({
      outputDir,
      stateDir: outputDir,
      adapters,
    });

    let results: SyncResult[];
    if (opts.adapter) {
      const result = await engine.syncOne(opts.adapter, mode);
      results = [result];
    } else {
      results = await engine.syncAll(mode);
    }

    printResults(results);

    const hasErrors = results.some((r) => r.errors.length > 0);
    process.exit(hasErrors ? 1 : 0);
  });

program
  .command("status")
  .description("Check sync status for all adapters")
  .option("--output <dir>", "Output directory", "./data")
  .action(async (opts) => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const adapterNames = ["slack", "notion", "linear", "gmail", "gog"];
    for (const name of adapterNames) {
      const stateFile = path.join(opts.output, name, "_meta", "state.json");
      try {
        const raw = fs.readFileSync(stateFile, "utf-8");
        const state = JSON.parse(raw);
        console.log(`${name}: last synced ${state.lastSyncAt ?? "never"}`);
      } catch {
        console.log(`${name}: no sync state found`);
      }
    }
  });

program
  .command("adapters")
  .description("List available adapters")
  .action(async () => {
    const adapters = await loadAdapters();
    if (adapters.length === 0) {
      console.log("No adapters configured. Set API credentials in .env");
    } else {
      console.log("Configured adapters:");
      for (const a of adapters) {
        console.log(`  - ${a.adapter.name}`);
      }
    }
  });

program
  .command("daemon")
  .description("Run as a long-lived daemon with periodic sync")
  .option("--interval <minutes>", "Minutes between sync cycles", "15")
  .option("--output <dir>", "Output directory", "./data")
  .action(async (opts) => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const intervalMs = parseInt(opts.interval, 10) * 60_000;
    const outputDir = opts.output;
    const adapters = await loadAdapters();

    if (adapters.length === 0) {
      console.error(
        "No adapters configured. Set API credentials in .env file.",
      );
      process.exit(1);
    }

    const engine = new SyncEngine({
      outputDir,
      stateDir: outputDir,
      adapters,
    });

    let shuttingDown = false;

    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(
        "\n[daemon] Graceful shutdown requested — finishing current sync...",
      );
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    console.log(
      `[daemon] Starting with ${adapters.length} adapters: ${adapters.map((a) => a.adapter.name).join(", ")}`,
    );
    console.log(`[daemon] Sync interval: ${opts.interval} minutes`);

    // Phase 1: Check each adapter's hydration state and run full sync if needed
    console.log("[daemon] Checking adapter hydration state...");
    for (const reg of adapters) {
      if (shuttingDown) break;
      const name = reg.adapter.name;
      const stateFile = path.join(outputDir, name, "_meta", "state.json");

      let needsHydration = true;
      try {
        const raw = fs.readFileSync(stateFile, "utf-8");
        const state = JSON.parse(raw);
        if (state.lastSyncAt) {
          console.log(
            `[daemon] ${name}: hydrated (last sync ${state.lastSyncAt})`,
          );
          needsHydration = false;
        }
      } catch {
        // No state file — needs hydration
      }

      if (needsHydration) {
        console.log(`[daemon] ${name}: not hydrated — running full sync`);
        try {
          const result = await engine.syncOne(name, "full");
          console.log(
            `[daemon] ${name}: full sync complete — ${result.itemsSynced} synced, ${result.itemsFailed} failed`,
          );
          if (result.errors.length > 0) {
            for (const err of result.errors.slice(0, 3)) {
              console.log(`[daemon]   ✗ ${err.entity}: ${err.error}`);
            }
          }
        } catch (err) {
          console.error(
            `[daemon] ${name}: full sync failed — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (shuttingDown) {
      console.log("[daemon] Shutdown during hydration. Exiting.");
      process.exit(0);
    }

    // Phase 2: Enter sync loop
    console.log("[daemon] All adapters checked. Entering sync loop.");

    while (!shuttingDown) {
      // Wait for next cycle
      const nextSync = new Date(Date.now() + intervalMs);
      console.log(
        `[daemon] Next sync at ${nextSync.toLocaleTimeString()} (in ${opts.interval} min)`,
      );

      // Sleep in 1-second increments so we can respond to shutdown quickly
      const sleepUntil = Date.now() + intervalMs;
      while (Date.now() < sleepUntil && !shuttingDown) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }

      if (shuttingDown) break;

      console.log("[daemon] Starting sync cycle...");
      const results = await engine.syncAll("incremental");
      printResults(results);
    }

    console.log("[daemon] Shutdown complete.");
    process.exit(0);
  });

program.parse();
