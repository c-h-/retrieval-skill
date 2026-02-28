import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OutputWriter } from "../../../src/connectors/core/index.js";
import { createOutputWriter } from "../../../src/connectors/core/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GmailLabel, GmailMessage } from "../../../src/connectors/gmail/types.js";
import { resolveLabels, writeLabels, writeMessage } from "../../../src/connectors/gmail/writer.js";

// ─── Helpers ───

function makeMessage(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "msg001",
    threadId: "thread001",
    labelIds: ["INBOX", "Label_1"],
    historyId: "12345",
    internalDate: 1704067200000,
    from: "alice@example.com",
    to: "bob@example.com",
    subject: "Test Email",
    date: "Mon, 01 Jan 2024 00:00:00 +0000",
    messageId: "<test@example.com>",
    bodyPlain: "Hello, this is a test email.",
    snippet: "Hello, this is a test",
    attachments: [],
    sizeEstimate: 1024,
    ...overrides,
  };
}

function makeLabelMap(labels: GmailLabel[]): Map<string, GmailLabel> {
  const map = new Map<string, GmailLabel>();
  for (const label of labels) {
    map.set(label.id, label);
  }
  return map;
}

const defaultLabels: GmailLabel[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "Label_1", name: "Work", type: "user" },
  { id: "Label_2", name: "Personal", type: "user" },
  { id: "Label_3", name: "Projects/Alpha", type: "user" },
];

// ─── resolveLabels tests ───

describe("resolveLabels", () => {
  const labelMap = makeLabelMap(defaultLabels);

  it("resolves known label IDs to their names", () => {
    const result = resolveLabels(["INBOX", "Label_1"], labelMap);
    expect(result).toEqual(["INBOX", "Work"]);
  });

  it("returns the raw ID for unknown labels", () => {
    const result = resolveLabels(["INBOX", "Label_999"], labelMap);
    expect(result).toEqual(["INBOX", "Label_999"]);
  });

  it("handles an empty label ID array", () => {
    const result = resolveLabels([], labelMap);
    expect(result).toEqual([]);
  });

  it("handles an empty label map", () => {
    const emptyMap = new Map<string, GmailLabel>();
    const result = resolveLabels(["INBOX", "Label_1"], emptyMap);
    expect(result).toEqual(["INBOX", "Label_1"]);
  });

  it("resolves all system labels", () => {
    const result = resolveLabels(["INBOX", "SENT", "UNREAD"], labelMap);
    expect(result).toEqual(["INBOX", "SENT", "UNREAD"]);
  });

  it("resolves nested label names (slashes in name)", () => {
    const result = resolveLabels(["Label_3"], labelMap);
    expect(result).toEqual(["Projects/Alpha"]);
  });

  it("preserves the order of input label IDs", () => {
    const result = resolveLabels(["Label_2", "INBOX", "Label_1"], labelMap);
    expect(result).toEqual(["Personal", "INBOX", "Work"]);
  });
});

// ─── writeMessage tests ───

describe("writeMessage", () => {
  let tmpDir: string;
  let writer: OutputWriter;
  const labelMap = makeLabelMap(defaultLabels);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-writer-test-"));
    writer = createOutputWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a message markdown file with correct frontmatter", async () => {
    const msg = makeMessage();
    await writeMessage(writer, msg, labelMap);

    const filePath = path.join(tmpDir, "messages", "msg001.md");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf-8");

    // Check frontmatter delimiters
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("---\n\n");

    // Check frontmatter fields
    expect(content).toContain("id: msg001");
    expect(content).toContain("thread_id: thread001");
    expect(content).toContain("from: alice@example.com");
    expect(content).toContain("to: bob@example.com");
    expect(content).toContain("subject: Test Email");

    // Check label names resolved
    expect(content).toContain("INBOX");
    expect(content).toContain("Work");
  });

  it("writes a message body as markdown content", async () => {
    const msg = makeMessage({ bodyPlain: "This is the body text." });
    await writeMessage(writer, msg, labelMap);

    const content = fs.readFileSync(
      path.join(tmpDir, "messages", "msg001.md"),
      "utf-8",
    );

    // Body appears after the frontmatter closing ---
    const parts = content.split("---\n\n");
    expect(parts.length).toBeGreaterThanOrEqual(2);
    const body = parts.slice(1).join("---\n\n");
    expect(body).toContain("This is the body text.");
  });

  it("writes metadata sidecar JSON", async () => {
    const msg = makeMessage();
    await writeMessage(writer, msg, labelMap);

    const metaPath = path.join(tmpDir, "messages", "msg001.meta.json");
    expect(fs.existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));

    expect(meta.id).toBe("msg001");
    expect(meta.threadId).toBe("thread001");
    expect(meta.historyId).toBe("12345");
    expect(meta.internalDate).toBe(1704067200000);
    expect(meta.from).toBe("alice@example.com");
    expect(meta.to).toBe("bob@example.com");
    expect(meta.subject).toBe("Test Email");
    expect(meta.messageId).toBe("<test@example.com>");
    expect(meta.labelIds).toEqual(["INBOX", "Label_1"]);
    expect(meta.labels).toEqual(["INBOX", "Work"]);
    expect(meta.sizeEstimate).toBe(1024);
    expect(meta.attachments).toEqual([]);
    expect(meta.syncedAt).toBeTruthy();
  });

  it("includes cc in frontmatter and meta when present", async () => {
    const msg = makeMessage({ cc: "charlie@example.com" });
    await writeMessage(writer, msg, labelMap);

    const mdContent = fs.readFileSync(
      path.join(tmpDir, "messages", "msg001.md"),
      "utf-8",
    );
    expect(mdContent).toContain("cc: charlie@example.com");

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "messages", "msg001.meta.json"),
        "utf-8",
      ),
    );
    expect(meta.cc).toBe("charlie@example.com");
  });

  it("includes bcc in frontmatter and meta when present", async () => {
    const msg = makeMessage({ bcc: "secret@example.com" });
    await writeMessage(writer, msg, labelMap);

    const mdContent = fs.readFileSync(
      path.join(tmpDir, "messages", "msg001.md"),
      "utf-8",
    );
    expect(mdContent).toContain("bcc: secret@example.com");

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "messages", "msg001.meta.json"),
        "utf-8",
      ),
    );
    expect(meta.bcc).toBe("secret@example.com");
  });

  it("omits cc/bcc from frontmatter and meta when absent", async () => {
    const msg = makeMessage(); // no cc/bcc
    await writeMessage(writer, msg, labelMap);

    const mdContent = fs.readFileSync(
      path.join(tmpDir, "messages", "msg001.md"),
      "utf-8",
    );
    // Make sure "cc:" and "bcc:" do not appear in the frontmatter area
    const frontmatterBlock = mdContent.split("---")[1];
    expect(frontmatterBlock).not.toContain("\ncc:");
    expect(frontmatterBlock).not.toContain("\nbcc:");

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "messages", "msg001.meta.json"),
        "utf-8",
      ),
    );
    expect(meta.cc).toBeUndefined();
    expect(meta.bcc).toBeUndefined();
  });

  it("includes inReplyTo and references in meta when present", async () => {
    const msg = makeMessage({
      inReplyTo: "<parent@example.com>",
      references: "<parent@example.com> <root@example.com>",
    });
    await writeMessage(writer, msg, labelMap);

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "messages", "msg001.meta.json"),
        "utf-8",
      ),
    );
    expect(meta.inReplyTo).toBe("<parent@example.com>");
    expect(meta.references).toBe("<parent@example.com> <root@example.com>");
  });

  it("omits inReplyTo and references from meta when absent", async () => {
    const msg = makeMessage(); // no inReplyTo/references
    await writeMessage(writer, msg, labelMap);

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "messages", "msg001.meta.json"),
        "utf-8",
      ),
    );
    expect(meta.inReplyTo).toBeUndefined();
    expect(meta.references).toBeUndefined();
  });

  it("adds attachment section to body when attachments exist", async () => {
    const msg = makeMessage({
      attachments: [
        {
          attachmentId: "att_001",
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 2048,
        },
        {
          attachmentId: "att_002",
          filename: "photo.jpg",
          mimeType: "image/jpeg",
          size: 10240,
        },
      ],
    });
    await writeMessage(writer, msg, labelMap);

    const content = fs.readFileSync(
      path.join(tmpDir, "messages", "msg001.md"),
      "utf-8",
    );

    expect(content).toContain("Attachments:");
    expect(content).toContain("[report.pdf]");
    expect(content).toContain("(2.0 KB)");
    expect(content).toContain("[photo.jpg]");
    expect(content).toContain("(10.0 KB)");
    // Attachment links should reference the correct path
    expect(content).toContain("../attachments/msg001/report.pdf");
    expect(content).toContain("../attachments/msg001/photo.jpg");
  });

  it("includes attachment metadata in sidecar JSON", async () => {
    const msg = makeMessage({
      attachments: [
        {
          attachmentId: "att_001",
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 2048,
        },
      ],
    });
    await writeMessage(writer, msg, labelMap);

    const meta = JSON.parse(
      fs.readFileSync(
        path.join(tmpDir, "messages", "msg001.meta.json"),
        "utf-8",
      ),
    );

    expect(meta.attachments).toHaveLength(1);
    expect(meta.attachments[0]).toEqual({
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 2048,
    });
  });

  it("sanitizes attachment filenames in markdown links", async () => {
    const msg = makeMessage({
      attachments: [
        {
          attachmentId: "att_special",
          filename: 'file "with" special:chars.pdf',
          mimeType: "application/pdf",
          size: 1024,
        },
      ],
    });
    await writeMessage(writer, msg, labelMap);

    const content = fs.readFileSync(
      path.join(tmpDir, "messages", "msg001.md"),
      "utf-8",
    );

    // sanitizeFilename replaces special chars with _
    expect(content).toContain("file__with__special_chars.pdf");
    // But the display name should be the original
    expect(content).toContain('[file "with" special:chars.pdf]');
  });

  it("uses unique message IDs for file names", async () => {
    const msg1 = makeMessage({ id: "aaa111" });
    const msg2 = makeMessage({ id: "bbb222" });

    await writeMessage(writer, msg1, labelMap);
    await writeMessage(writer, msg2, labelMap);

    expect(fs.existsSync(path.join(tmpDir, "messages", "aaa111.md"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(tmpDir, "messages", "bbb222.md"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(tmpDir, "messages", "aaa111.meta.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpDir, "messages", "bbb222.meta.json")),
    ).toBe(true);
  });

  it("writes HTML-only message body as converted markdown", async () => {
    const msg = makeMessage({
      bodyPlain: undefined,
      bodyHtml: "<h1>Important</h1><p>This is <em>emphasized</em>.</p>",
    });
    await writeMessage(writer, msg, labelMap);

    const content = fs.readFileSync(
      path.join(tmpDir, "messages", "msg001.md"),
      "utf-8",
    );

    // bodyToMarkdown converts HTML since no plain text
    expect(content).toContain("Important");
    // Turndown converts <em> to _text_ (underscore style)
    expect(content).toContain("_emphasized_");
  });

  it("falls back to snippet when no plain or HTML body", async () => {
    const msg = makeMessage({
      bodyPlain: undefined,
      bodyHtml: undefined,
      snippet: "Snippet fallback content",
    });
    await writeMessage(writer, msg, labelMap);

    const content = fs.readFileSync(
      path.join(tmpDir, "messages", "msg001.md"),
      "utf-8",
    );

    expect(content).toContain("Snippet fallback content");
  });

  it("overwrites existing message files on re-write", async () => {
    const msg1 = makeMessage({ subject: "Original" });
    await writeMessage(writer, msg1, labelMap);

    const msg2 = makeMessage({ subject: "Updated" });
    await writeMessage(writer, msg2, labelMap);

    const content = fs.readFileSync(
      path.join(tmpDir, "messages", "msg001.md"),
      "utf-8",
    );
    expect(content).toContain("subject: Updated");
    expect(content).not.toContain("subject: Original");
  });

  it("handles message with all optional fields populated", async () => {
    const msg = makeMessage({
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      inReplyTo: "<parent@example.com>",
      references: "<parent@example.com>",
      bodyPlain: "Full message",
      bodyHtml: "<p>Full message</p>",
      attachments: [
        {
          attachmentId: "att_full",
          filename: "doc.txt",
          mimeType: "text/plain",
          size: 512,
        },
      ],
    });
    await writeMessage(writer, msg, labelMap);

    const mdPath = path.join(tmpDir, "messages", "msg001.md");
    const metaPath = path.join(tmpDir, "messages", "msg001.meta.json");

    expect(fs.existsSync(mdPath)).toBe(true);
    expect(fs.existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    expect(meta.cc).toBe("cc@example.com");
    expect(meta.bcc).toBe("bcc@example.com");
    expect(meta.inReplyTo).toBe("<parent@example.com>");
    expect(meta.references).toBe("<parent@example.com>");
    expect(meta.attachments).toHaveLength(1);
  });
});

// ─── writeLabels tests ───

describe("writeLabels", () => {
  let tmpDir: string;
  let writer: OutputWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-labels-test-"));
    writer = createOutputWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes labels as _labels.json", async () => {
    const labels: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "SENT", name: "SENT", type: "system" },
      { id: "Label_1", name: "Work", type: "user" },
    ];

    await writeLabels(writer, labels);

    const filePath = path.join(tmpDir, "_labels.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    expect(data.INBOX).toEqual({ name: "INBOX", type: "system" });
    expect(data.SENT).toEqual({ name: "SENT", type: "system" });
    expect(data.Label_1).toEqual({ name: "Work", type: "user" });
  });

  it("writes an empty object for no labels", async () => {
    await writeLabels(writer, []);

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "_labels.json"), "utf-8"),
    );
    expect(data).toEqual({});
  });

  it("handles labels with special characters in names", async () => {
    const labels: GmailLabel[] = [
      { id: "Label_special", name: "Projects/Alpha & Beta", type: "user" },
      { id: "Label_emoji", name: "Stars/Important", type: "user" },
    ];

    await writeLabels(writer, labels);

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "_labels.json"), "utf-8"),
    );
    expect(data.Label_special.name).toBe("Projects/Alpha & Beta");
    expect(data.Label_emoji.name).toBe("Stars/Important");
  });

  it("overwrites existing _labels.json on re-write", async () => {
    const labels1: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
    ];
    await writeLabels(writer, labels1);

    const labels2: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_new", name: "New Label", type: "user" },
    ];
    await writeLabels(writer, labels2);

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "_labels.json"), "utf-8"),
    );
    expect(Object.keys(data)).toHaveLength(2);
    expect(data.Label_new).toEqual({ name: "New Label", type: "user" });
  });

  it("writes valid JSON (parseable by JSON.parse)", async () => {
    const labels: GmailLabel[] = [
      { id: "L1", name: "Label One", type: "user" },
      { id: "L2", name: "Label Two", type: "user" },
      { id: "L3", name: "Label Three", type: "user" },
    ];

    await writeLabels(writer, labels);

    const raw = fs.readFileSync(path.join(tmpDir, "_labels.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("preserves label type information", async () => {
    const labels: GmailLabel[] = [
      { id: "INBOX", name: "INBOX", type: "system" },
      { id: "Label_user", name: "My Label", type: "user" },
    ];

    await writeLabels(writer, labels);

    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "_labels.json"), "utf-8"),
    );
    expect(data.INBOX.type).toBe("system");
    expect(data.Label_user.type).toBe("user");
  });
});
