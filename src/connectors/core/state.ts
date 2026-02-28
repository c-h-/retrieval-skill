import * as fs from "node:fs";
import * as path from "node:path";
import type { AdapterState, PersistedState } from "./types.js";

const DEFAULT_STATE: PersistedState = {
  lastSyncAt: null,
  cursors: {},
  metadata: {},
};

export class StateManager {
  private state: PersistedState;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.state = this.loadFromDisk();
  }

  private loadFromDisk(): PersistedState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw) as PersistedState;
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  private async writeToDisk(): Promise<void> {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  getAdapterState(): AdapterState {
    const self = this;
    return {
      get lastSyncAt() {
        return self.state.lastSyncAt;
      },
      set lastSyncAt(val: string | null) {
        self.state.lastSyncAt = val;
      },
      get cursors() {
        return self.state.cursors;
      },
      set cursors(val: Record<string, string>) {
        self.state.cursors = val;
      },
      get metadata() {
        return self.state.metadata;
      },
      set metadata(val: Record<string, unknown>) {
        self.state.metadata = val;
      },
      async checkpoint() {
        await self.writeToDisk();
      },
    };
  }

  async save(): Promise<void> {
    this.state.lastSyncAt = new Date().toISOString();
    await this.writeToDisk();
  }

  getRawState(): PersistedState {
    return { ...this.state };
  }
}
