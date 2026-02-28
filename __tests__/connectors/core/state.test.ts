import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateManager } from "../../../src/connectors/core/state.js";

describe("StateManager", () => {
  let tmpDir: string;
  let stateFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "saas-mirror-test-"));
    stateFile = path.join(tmpDir, "state.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns default state when no file exists", () => {
    const mgr = new StateManager(stateFile);
    const state = mgr.getAdapterState();
    expect(state.lastSyncAt).toBeNull();
    expect(state.cursors).toEqual({});
    expect(state.metadata).toEqual({});
  });

  it("loads existing state from disk", () => {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        lastSyncAt: "2026-01-01T00:00:00Z",
        cursors: { page: "abc" },
        metadata: { count: 42 },
      }),
    );
    const mgr = new StateManager(stateFile);
    const state = mgr.getAdapterState();
    expect(state.lastSyncAt).toBe("2026-01-01T00:00:00Z");
    expect(state.cursors.page).toBe("abc");
    expect(state.metadata.count).toBe(42);
  });

  it("checkpoints state to disk", async () => {
    const mgr = new StateManager(stateFile);
    const state = mgr.getAdapterState();
    state.cursors.page = "xyz";
    state.metadata.foo = "bar";
    await state.checkpoint();

    const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(raw.cursors.page).toBe("xyz");
    expect(raw.metadata.foo).toBe("bar");
  });

  it("save sets lastSyncAt", async () => {
    const mgr = new StateManager(stateFile);
    await mgr.save();

    const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(raw.lastSyncAt).toBeTruthy();
    expect(new Date(raw.lastSyncAt).getTime()).toBeGreaterThan(0);
  });

  it("mutations on state reflect in checkpoint", async () => {
    const mgr = new StateManager(stateFile);
    const state = mgr.getAdapterState();
    state.cursors.a = "1";
    await state.checkpoint();

    state.cursors.b = "2";
    await state.checkpoint();

    const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
    expect(raw.cursors.a).toBe("1");
    expect(raw.cursors.b).toBe("2");
  });
});
