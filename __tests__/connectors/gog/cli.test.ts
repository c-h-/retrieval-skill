import { execFile } from "node:child_process";
import type { Logger } from "../../../src/connectors/core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GogCli } from "../../../src/connectors/gog/cli.js";

// Mock child_process.execFile
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    progress: vi.fn(),
  };
}

describe("GogCli", () => {
  let cli: GogCli;

  beforeEach(() => {
    vi.clearAllMocks();
    cli = new GogCli("test@example.com", makeLogger(), "/usr/bin/gog");
  });

  describe("listLabels", () => {
    it("parses labels from JSON output", async () => {
      const jsonOutput = JSON.stringify({
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "Label_1", name: "Custom", type: "user" },
        ],
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, jsonOutput, "");
        return {} as ReturnType<typeof execFile>;
      });

      const labels = await cli.listLabels();
      expect(labels).toHaveLength(2);
      expect(labels[0]?.id).toBe("INBOX");

      // Verify correct CLI args
      const callArgs = mockExecFile.mock.calls[0]!;
      expect(callArgs[0]).toBe("/usr/bin/gog");
      expect(callArgs[1]).toContain("--json");
      expect(callArgs[1]).toContain("--no-input");
      expect(callArgs[1]).toContain("--account");
      expect(callArgs[1]).toContain("test@example.com");
    });
  });

  describe("searchMessages", () => {
    it("parses message summaries and pagination token", async () => {
      const jsonOutput = JSON.stringify({
        messages: [
          {
            id: "msg-1",
            threadId: "t-1",
            from: "alice@example.com",
            subject: "Test",
            date: "2024-01-01",
            labels: ["INBOX"],
          },
        ],
        nextPageToken: "page2",
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, jsonOutput, "");
        return {} as ReturnType<typeof execFile>;
      });

      const result = await cli.searchMessages("in:anywhere", 500);
      expect(result.messages).toHaveLength(1);
      expect(result.nextPageToken).toBe("page2");
    });

    it("passes page token when provided", async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, '{"messages":[]}', "");
        return {} as ReturnType<typeof execFile>;
      });

      await cli.searchMessages("in:inbox", 100, "token123");

      const callArgs = mockExecFile.mock.calls[0]!;
      const args = callArgs[1] as string[];
      expect(args).toContain("--page");
      expect(args).toContain("token123");
    });
  });

  describe("getMessage", () => {
    it("parses full message", async () => {
      const jsonOutput = JSON.stringify({
        body: "Hello",
        headers: {
          from: "alice@example.com",
          to: "bob@example.com",
          cc: "",
          bcc: "",
          date: "2024-01-01",
          subject: "Hi",
        },
        message: {
          id: "msg-1",
          threadId: "t-1",
          historyId: "123",
          internalDate: "1704067200000",
          labelIds: ["INBOX"],
          payload: { body: {}, headers: [], mimeType: "text/plain" },
          sizeEstimate: 100,
          snippet: "Hello",
        },
      });

      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, jsonOutput, "");
        return {} as ReturnType<typeof execFile>;
      });

      const msg = await cli.getMessage("msg-1");
      expect(msg.body).toBe("Hello");
      expect(msg.message.id).toBe("msg-1");
    });
  });

  describe("error handling", () => {
    it("rejects with descriptive error on CLI failure", async () => {
      mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        (callback as Function)(new Error("exit code 1"), "", "auth failed");
        return {} as ReturnType<typeof execFile>;
      });

      await expect(cli.listLabels()).rejects.toThrow("auth failed");
    });
  });
});
