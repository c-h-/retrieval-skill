import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../../../src/connectors/core/engine.js";
import type { Adapter, SyncContext, SyncResult } from "../../../src/connectors/core/types.js";

class MockAdapter implements Adapter {
  name = "mock";
  syncCalls: SyncContext[] = [];
  result: Partial<SyncResult> = {};

  async sync(ctx: SyncContext): Promise<SyncResult> {
    this.syncCalls.push(ctx);
    return {
      adapter: this.name,
      mode: ctx.mode,
      itemsSynced: this.result.itemsSynced ?? 10,
      itemsFailed: this.result.itemsFailed ?? 0,
      errors: this.result.errors ?? [],
      durationMs: this.result.durationMs ?? 100,
    };
  }
}

describe("SyncEngine", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saas-mirror-engine-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs a single adapter", async () => {
    const adapter = new MockAdapter();
    const engine = new SyncEngine({
      outputDir: tmpDir,
      stateDir: tmpDir,
      adapters: [{ adapter }],
    });

    const result = await engine.syncOne("mock", "full");
    expect(result.adapter).toBe("mock");
    expect(result.itemsSynced).toBe(10);
    expect(adapter.syncCalls).toHaveLength(1);
    expect(adapter.syncCalls[0].mode).toBe("full");
  });

  it("runs all adapters", async () => {
    const adapter1 = new MockAdapter();
    adapter1.name = "a";
    const adapter2 = new MockAdapter();
    adapter2.name = "b";
    const engine = new SyncEngine({
      outputDir: tmpDir,
      stateDir: tmpDir,
      adapters: [{ adapter: adapter1 }, { adapter: adapter2 }],
    });

    const results = await engine.syncAll("full");
    expect(results).toHaveLength(2);
    expect(results[0].adapter).toBe("a");
    expect(results[1].adapter).toBe("b");
  });

  it("falls back to full when no prior state for incremental", async () => {
    const adapter = new MockAdapter();
    const engine = new SyncEngine({
      outputDir: tmpDir,
      stateDir: tmpDir,
      adapters: [{ adapter }],
    });

    const result = await engine.syncOne("mock", "incremental");
    expect(result.mode).toBe("full"); // fallback
    expect(adapter.syncCalls[0].mode).toBe("full");
  });

  it("throws for unknown adapter", async () => {
    const engine = new SyncEngine({
      outputDir: tmpDir,
      stateDir: tmpDir,
      adapters: [{ adapter: new MockAdapter() }],
    });

    await expect(engine.syncOne("unknown", "full")).rejects.toThrow(
      'Adapter "unknown" not found',
    );
  });

  it("catches adapter errors and returns error result", async () => {
    const adapter = new MockAdapter();
    adapter.sync = async () => {
      throw new Error("API key invalid");
    };
    const engine = new SyncEngine({
      outputDir: tmpDir,
      stateDir: tmpDir,
      adapters: [{ adapter }],
    });

    const result = await engine.syncOne("mock", "full");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("API key invalid");
  });

  it("lists adapters", () => {
    const adapter = new MockAdapter();
    const engine = new SyncEngine({
      outputDir: tmpDir,
      stateDir: tmpDir,
      adapters: [{ adapter }],
    });

    expect(engine.listAdapters()).toEqual(["mock"]);
  });
});
