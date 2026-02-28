import type { OutputWriter } from "../../../src/connectors/core/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GogLabel, GogMessageFull } from "../../../src/connectors/gog/types.js";
import {
  removeMessage,
  writeLabels,
  writeMessage,
  writeThreadView,
} from "../../../src/connectors/gog/writer.js";

function makeWriter(): OutputWriter & {
  written: Array<{ method: string; path: string; args: unknown[] }>;
} {
  const written: Array<{ method: string; path: string; args: unknown[] }> = [];
  return {
    written,
    writeDocument: vi.fn(
      async (path: string, fm: Record<string, unknown>, body: string) => {
        written.push({ method: "writeDocument", path, args: [fm, body] });
      },
    ),
    writeMeta: vi.fn(async (path: string, data: Record<string, unknown>) => {
      written.push({ method: "writeMeta", path, args: [data] });
    }),
    writeJsonl: vi.fn(async () => {}),
    appendJsonl: vi.fn(async () => {}),
    writeBinary: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  };
}

function makeMessage(overrides?: Partial<GogMessageFull>): GogMessageFull {
  return {
    body: "Hello world",
    headers: {
      from: "alice@example.com",
      to: "bob@example.com",
      cc: "",
      bcc: "",
      date: "Mon, 01 Jan 2024 12:00:00 +0000",
      subject: "Test Subject",
    },
    message: {
      id: "msg-001",
      threadId: "thread-001",
      historyId: "12345",
      internalDate: "1704067200000",
      labelIds: ["INBOX", "UNREAD"],
      payload: {
        body: {},
        headers: [],
        mimeType: "text/plain",
      },
      sizeEstimate: 1024,
      snippet: "Hello world...",
    },
    ...overrides,
  };
}

describe("GOG Writer", () => {
  let writer: ReturnType<typeof makeWriter>;
  const labelMap = new Map([
    ["INBOX", "INBOX"],
    ["UNREAD", "UNREAD"],
    ["SENT", "SENT"],
  ]);

  beforeEach(() => {
    writer = makeWriter();
  });

  describe("writeMessage", () => {
    it("writes markdown and meta files", async () => {
      const msg = makeMessage();
      await writeMessage(writer, msg, labelMap);

      expect(writer.writeDocument).toHaveBeenCalledOnce();
      expect(writer.writeMeta).toHaveBeenCalledOnce();

      const docCall = writer.written.find((w) => w.method === "writeDocument")!;
      expect(docCall.path).toBe("messages/msg-001.md");

      const metaCall = writer.written.find((w) => w.method === "writeMeta")!;
      expect(metaCall.path).toBe("messages/msg-001.meta.json");
    });

    it("includes correct frontmatter fields", async () => {
      const msg = makeMessage();
      await writeMessage(writer, msg, labelMap);

      const docCall = writer.written.find((w) => w.method === "writeDocument")!;
      const fm = docCall.args[0] as Record<string, unknown>;

      expect(fm.id).toBe("msg-001");
      expect(fm.threadId).toBe("thread-001");
      expect(fm.from).toBe("alice@example.com");
      expect(fm.to).toBe("bob@example.com");
      expect(fm.subject).toBe("Test Subject");
      expect(fm.labels).toEqual(["INBOX", "UNREAD"]);
    });

    it("strips empty cc/bcc fields", async () => {
      const msg = makeMessage();
      await writeMessage(writer, msg, labelMap);

      const docCall = writer.written.find((w) => w.method === "writeDocument")!;
      const fm = docCall.args[0] as Record<string, unknown>;

      expect(fm.cc).toBeUndefined();
      expect(fm.bcc).toBeUndefined();
    });

    it("uses (no body) for empty body", async () => {
      const msg = makeMessage({ body: "" });
      await writeMessage(writer, msg, labelMap);

      const docCall = writer.written.find((w) => w.method === "writeDocument")!;
      const body = docCall.args[1] as string;
      expect(body).toBe("(no body)");
    });
  });

  describe("writeLabels", () => {
    it("writes labels meta file", async () => {
      const labels: GogLabel[] = [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "Label_1", name: "Custom", type: "user" },
      ];

      await writeLabels(writer, labels);

      expect(writer.writeMeta).toHaveBeenCalledOnce();
      const call = writer.written.find((w) => w.method === "writeMeta")!;
      expect(call.path).toBe("_meta/labels.json");
    });
  });

  describe("writeThreadView", () => {
    it("writes thread markdown with sorted messages", async () => {
      const messages = [
        makeMessage({
          message: {
            ...makeMessage().message,
            id: "msg-002",
            internalDate: "1704067400000",
          },
          headers: {
            ...makeMessage().headers,
            from: "bob@example.com",
          },
          body: "Reply message",
        }),
        makeMessage(),
      ];

      await writeThreadView(writer, "thread-001", messages, labelMap);

      expect(writer.writeDocument).toHaveBeenCalledOnce();
      const call = writer.written.find((w) => w.method === "writeDocument")!;
      expect(call.path).toBe("threads/thread-001.md");

      const fm = call.args[0] as Record<string, unknown>;
      expect(fm.threadId).toBe("thread-001");
      expect(fm.messageCount).toBe(2);
    });

    it("skips empty message list", async () => {
      await writeThreadView(writer, "thread-001", [], labelMap);
      expect(writer.writeDocument).not.toHaveBeenCalled();
    });
  });

  describe("removeMessage", () => {
    it("removes markdown and meta files", async () => {
      await removeMessage(writer, "msg-001");
      expect(writer.remove).toHaveBeenCalledTimes(2);
    });
  });
});
