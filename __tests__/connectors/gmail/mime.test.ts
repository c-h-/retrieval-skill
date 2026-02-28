import type { gmail_v1 } from "googleapis";
import { describe, expect, it } from "vitest";
import { bodyToMarkdown, getHeader, parseMessage, walkParts } from "../../../src/connectors/gmail/mime.js";
import type { GmailMessage } from "../../../src/connectors/gmail/types.js";

// ─── Helpers ───

/** Encode a UTF-8 string as base64url (mimicking Gmail API body encoding). */
function b64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

// ─── Test fixtures ───

function makeSimpleTextMessage(): gmail_v1.Schema$Message {
  return {
    id: "msg123",
    threadId: "thread123",
    historyId: "12345",
    labelIds: ["INBOX", "UNREAD"],
    sizeEstimate: 1024,
    internalDate: "1704067200000",
    snippet: "Hello world",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "alice@example.com" },
        { name: "To", value: "bob@example.com" },
        { name: "Subject", value: "Test Subject" },
        { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
        { name: "Message-ID", value: "<abc@example.com>" },
      ],
      body: { size: 11, data: b64url("Hello world") },
    },
  };
}

function makeMultipartMessage(): gmail_v1.Schema$Message {
  return {
    id: "msg456",
    threadId: "thread456",
    historyId: "67890",
    labelIds: ["INBOX"],
    sizeEstimate: 4096,
    internalDate: "1704153600000",
    snippet: "Rich email",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "carol@example.com" },
        { name: "To", value: "dave@example.com" },
        { name: "Cc", value: "eve@example.com" },
        { name: "Subject", value: "Multipart Test" },
        { name: "Date", value: "Tue, 02 Jan 2024 00:00:00 +0000" },
        { name: "Message-ID", value: "<def@example.com>" },
        { name: "In-Reply-To", value: "<abc@example.com>" },
        { name: "References", value: "<abc@example.com>" },
      ],
      body: { size: 0 },
      parts: [
        {
          mimeType: "multipart/alternative",
          body: { size: 0 },
          parts: [
            {
              mimeType: "text/plain",
              body: { size: 10, data: b64url("Rich email") },
            },
            {
              mimeType: "text/html",
              body: {
                size: 30,
                data: b64url("<p>Rich <strong>email</strong></p>"),
              },
            },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "report.pdf",
          body: {
            attachmentId: "att_001",
            size: 2048,
          },
          headers: [
            {
              name: "Content-Type",
              value: 'application/pdf; name="report.pdf"',
            },
          ],
        },
      ],
    },
  };
}

function makeMultipartRelatedMessage(): gmail_v1.Schema$Message {
  return {
    id: "msg789",
    threadId: "thread789",
    historyId: "11111",
    labelIds: ["INBOX"],
    sizeEstimate: 8192,
    internalDate: "1704240000000",
    snippet: "Inline image email",
    payload: {
      mimeType: "multipart/related",
      headers: [
        { name: "From", value: "frank@example.com" },
        { name: "To", value: "grace@example.com" },
        { name: "Subject", value: "Inline Image" },
        { name: "Date", value: "Wed, 03 Jan 2024 00:00:00 +0000" },
        { name: "Message-ID", value: "<ghi@example.com>" },
      ],
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/html",
          body: {
            size: 50,
            data: b64url('<p>Look at this:</p><img src="cid:img001" />'),
          },
        },
        {
          mimeType: "image/png",
          filename: "screenshot.png",
          body: {
            attachmentId: "att_002",
            size: 4096,
          },
          headers: [
            { name: "Content-ID", value: "<img001>" },
            {
              name: "Content-Type",
              value: "image/png",
            },
          ],
        },
      ],
    },
  };
}

// ─── walkParts tests ───

describe("walkParts", () => {
  it("returns empty result for null/undefined payload", () => {
    const result = walkParts(null);
    expect(result).toEqual({ plain: "", html: "", attachments: [] });

    const result2 = walkParts(undefined);
    expect(result2).toEqual({ plain: "", html: "", attachments: [] });
  });

  it("extracts text/plain body from a simple payload", () => {
    const payload = makeSimpleTextMessage().payload!;
    const result = walkParts(payload);
    expect(result.plain).toBe("Hello world");
    expect(result.html).toBe("");
    expect(result.attachments).toHaveLength(0);
  });

  it("extracts both text and html from multipart/alternative", () => {
    const payload = makeMultipartMessage().payload!;
    const result = walkParts(payload);
    expect(result.plain).toBe("Rich email");
    expect(result.html).toBe("<p>Rich <strong>email</strong></p>");
    expect(result.attachments).toHaveLength(1);
  });

  it("extracts attachment metadata from multipart/mixed", () => {
    const payload = makeMultipartMessage().payload!;
    const result = walkParts(payload);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({
      attachmentId: "att_001",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 2048,
      contentId: undefined,
    });
  });

  it("extracts inline images with contentId from multipart/related", () => {
    const payload = makeMultipartRelatedMessage().payload!;
    const result = walkParts(payload);
    expect(result.html).toContain("cid:img001");
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      attachmentId: "att_002",
      filename: "screenshot.png",
      mimeType: "image/png",
      size: 4096,
      contentId: "img001",
    });
  });

  it("handles deeply nested multipart structures", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "multipart/related",
          body: { size: 0 },
          parts: [
            {
              mimeType: "multipart/alternative",
              body: { size: 0 },
              parts: [
                {
                  mimeType: "text/plain",
                  body: { size: 4, data: b64url("Deep") },
                },
                {
                  mimeType: "text/html",
                  body: { size: 12, data: b64url("<b>Deep</b>") },
                },
              ],
            },
            {
              mimeType: "image/jpeg",
              filename: "photo.jpg",
              body: { attachmentId: "att_deep", size: 1000 },
            },
          ],
        },
        {
          mimeType: "application/zip",
          filename: "archive.zip",
          body: { attachmentId: "att_zip", size: 5000 },
        },
      ],
    };

    const result = walkParts(payload);
    expect(result.plain).toBe("Deep");
    expect(result.html).toBe("<b>Deep</b>");
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments.map((a) => a.filename)).toEqual([
      "photo.jpg",
      "archive.zip",
    ]);
  });

  it("concatenates multiple text/plain parts", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/plain",
          body: { size: 5, data: b64url("Hello") },
        },
        {
          mimeType: "text/plain",
          body: { size: 5, data: b64url(" World") },
        },
      ],
    };

    const result = walkParts(payload);
    expect(result.plain).toBe("Hello World");
  });

  it("ignores body data on parts with filenames (treats as attachment)", () => {
    // A part with a filename and body data but no attachmentId => not an attachment
    // but also not a text part because it has a filename
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      filename: "message.txt",
      body: { size: 5, data: b64url("Hello") },
    };

    const result = walkParts(payload);
    // Has filename so won't be treated as body text, but no attachmentId so not attachment either
    expect(result.plain).toBe("");
    expect(result.attachments).toHaveLength(0);
  });

  it("handles a payload with empty body data", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      body: { size: 0 },
    };

    const result = walkParts(payload);
    expect(result.plain).toBe("");
  });

  it("assigns application/octet-stream when mimeType is missing on attachment", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          // mimeType intentionally omitted (undefined)
          filename: "mystery.bin",
          body: { attachmentId: "att_unknown", size: 100 },
        },
      ],
    };

    const result = walkParts(payload);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].mimeType).toBe("application/octet-stream");
  });

  it("defaults attachment size to 0 when body size is missing", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "application/pdf",
          filename: "doc.pdf",
          body: { attachmentId: "att_no_size" },
        },
      ],
    };

    const result = walkParts(payload);
    expect(result.attachments[0].size).toBe(0);
  });

  it("handles multiple attachments with same filename", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/plain",
          body: { size: 4, data: b64url("Body") },
        },
        {
          mimeType: "image/png",
          filename: "image.png",
          body: { attachmentId: "att_a", size: 100 },
        },
        {
          mimeType: "image/png",
          filename: "image.png",
          body: { attachmentId: "att_b", size: 200 },
        },
      ],
    };

    const result = walkParts(payload);
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].attachmentId).toBe("att_a");
    expect(result.attachments[1].attachmentId).toBe("att_b");
  });
});

// ─── getHeader tests ───

describe("getHeader", () => {
  const headers: gmail_v1.Schema$MessagePartHeader[] = [
    { name: "From", value: "alice@example.com" },
    { name: "To", value: "bob@example.com" },
    { name: "Subject", value: "Test Subject" },
    { name: "Content-Type", value: "text/html; charset=utf-8" },
    { name: "X-Custom-Header", value: "custom-value" },
  ];

  it("retrieves a header by exact name", () => {
    expect(getHeader(headers, "From")).toBe("alice@example.com");
    expect(getHeader(headers, "Subject")).toBe("Test Subject");
  });

  it("is case-insensitive", () => {
    expect(getHeader(headers, "from")).toBe("alice@example.com");
    expect(getHeader(headers, "FROM")).toBe("alice@example.com");
    expect(getHeader(headers, "subject")).toBe("Test Subject");
    expect(getHeader(headers, "SUBJECT")).toBe("Test Subject");
    expect(getHeader(headers, "content-type")).toBe("text/html; charset=utf-8");
  });

  it("returns empty string for missing headers", () => {
    expect(getHeader(headers, "Bcc")).toBe("");
    expect(getHeader(headers, "Reply-To")).toBe("");
  });

  it("returns empty string for null/undefined headers array", () => {
    expect(getHeader(null, "From")).toBe("");
    expect(getHeader(undefined, "From")).toBe("");
  });

  it("returns empty string for an empty headers array", () => {
    expect(getHeader([], "From")).toBe("");
  });

  it("handles headers with undefined name or value", () => {
    const weirdHeaders: gmail_v1.Schema$MessagePartHeader[] = [
      { name: undefined, value: "orphan-value" },
      { name: "X-Real", value: undefined },
      { name: "X-Good", value: "found" },
    ];
    expect(getHeader(weirdHeaders, "X-Real")).toBe("");
    expect(getHeader(weirdHeaders, "X-Good")).toBe("found");
  });

  it("retrieves custom X- headers", () => {
    expect(getHeader(headers, "X-Custom-Header")).toBe("custom-value");
    expect(getHeader(headers, "x-custom-header")).toBe("custom-value");
  });
});

// ─── parseMessage tests ───

describe("parseMessage", () => {
  it("parses a simple text/plain message", () => {
    const raw = makeSimpleTextMessage();
    const parsed = parseMessage(raw);

    expect(parsed.id).toBe("msg123");
    expect(parsed.threadId).toBe("thread123");
    expect(parsed.historyId).toBe("12345");
    expect(parsed.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(parsed.sizeEstimate).toBe(1024);
    expect(parsed.internalDate).toBe(1704067200000);
    expect(parsed.from).toBe("alice@example.com");
    expect(parsed.to).toBe("bob@example.com");
    expect(parsed.subject).toBe("Test Subject");
    expect(parsed.date).toBe("Mon, 01 Jan 2024 00:00:00 +0000");
    expect(parsed.messageId).toBe("<abc@example.com>");
    expect(parsed.snippet).toBe("Hello world");
    expect(parsed.bodyPlain).toBe("Hello world");
    expect(parsed.bodyHtml).toBeUndefined();
    expect(parsed.cc).toBeUndefined();
    expect(parsed.bcc).toBeUndefined();
    expect(parsed.inReplyTo).toBeUndefined();
    expect(parsed.references).toBeUndefined();
    expect(parsed.attachments).toHaveLength(0);
  });

  it("parses a multipart message with cc, in-reply-to, references", () => {
    const raw = makeMultipartMessage();
    const parsed = parseMessage(raw);

    expect(parsed.id).toBe("msg456");
    expect(parsed.threadId).toBe("thread456");
    expect(parsed.from).toBe("carol@example.com");
    expect(parsed.to).toBe("dave@example.com");
    expect(parsed.cc).toBe("eve@example.com");
    expect(parsed.bcc).toBeUndefined();
    expect(parsed.subject).toBe("Multipart Test");
    expect(parsed.messageId).toBe("<def@example.com>");
    expect(parsed.inReplyTo).toBe("<abc@example.com>");
    expect(parsed.references).toBe("<abc@example.com>");
    expect(parsed.bodyPlain).toBe("Rich email");
    expect(parsed.bodyHtml).toBe("<p>Rich <strong>email</strong></p>");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("report.pdf");
  });

  it("defaults labelIds to empty array when missing", () => {
    const raw: gmail_v1.Schema$Message = {
      id: "msg_nolabels",
      threadId: "thread_nolabels",
      historyId: "99999",
      internalDate: "0",
      snippet: "",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { size: 0 },
      },
    };
    const parsed = parseMessage(raw);
    expect(parsed.labelIds).toEqual([]);
  });

  it("defaults internalDate to 0 when missing or empty", () => {
    const raw: gmail_v1.Schema$Message = {
      id: "msg_nodate",
      threadId: "thread_nodate",
      historyId: "99999",
      snippet: "",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { size: 0 },
      },
    };
    const parsed = parseMessage(raw);
    expect(parsed.internalDate).toBe(0);
  });

  it("defaults sizeEstimate to 0 when missing", () => {
    const raw: gmail_v1.Schema$Message = {
      id: "msg_nosize",
      threadId: "thread_nosize",
      historyId: "99999",
      internalDate: "0",
      snippet: "",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { size: 0 },
      },
    };
    const parsed = parseMessage(raw);
    expect(parsed.sizeEstimate).toBe(0);
  });

  it("defaults snippet to empty string when missing", () => {
    const raw: gmail_v1.Schema$Message = {
      id: "msg_nosnippet",
      threadId: "thread_nosnippet",
      historyId: "99999",
      internalDate: "0",
      payload: {
        mimeType: "text/plain",
        headers: [],
        body: { size: 0 },
      },
    };
    const parsed = parseMessage(raw);
    expect(parsed.snippet).toBe("");
  });

  it("handles a message with only HTML body (no plain text)", () => {
    const raw: gmail_v1.Schema$Message = {
      id: "msg_html_only",
      threadId: "thread_html",
      historyId: "11111",
      labelIds: ["INBOX"],
      sizeEstimate: 512,
      internalDate: "1704067200000",
      snippet: "HTML only",
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "recipient@example.com" },
          { name: "Subject", value: "HTML Only" },
          { name: "Date", value: "Mon, 01 Jan 2024 00:00:00 +0000" },
          { name: "Message-ID", value: "<html@example.com>" },
        ],
        body: {
          size: 30,
          data: b64url("<h1>Hello</h1><p>World</p>"),
        },
      },
    };

    const parsed = parseMessage(raw);
    expect(parsed.bodyPlain).toBeUndefined();
    expect(parsed.bodyHtml).toBe("<h1>Hello</h1><p>World</p>");
  });

  it("handles a message with empty payload (no body at all)", () => {
    const raw: gmail_v1.Schema$Message = {
      id: "msg_empty",
      threadId: "thread_empty",
      historyId: "00000",
      labelIds: [],
      sizeEstimate: 0,
      internalDate: "0",
      snippet: "",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "nobody@example.com" },
          { name: "To", value: "nobody@example.com" },
          { name: "Subject", value: "" },
          { name: "Date", value: "" },
          { name: "Message-ID", value: "" },
        ],
        body: { size: 0 },
        parts: [],
      },
    };

    const parsed = parseMessage(raw);
    expect(parsed.bodyPlain).toBeUndefined();
    expect(parsed.bodyHtml).toBeUndefined();
    expect(parsed.attachments).toHaveLength(0);
  });
});

// ─── bodyToMarkdown tests ───

describe("bodyToMarkdown", () => {
  it("returns bodyPlain when available (priority 1)", () => {
    const msg: GmailMessage = {
      id: "m1",
      threadId: "t1",
      labelIds: [],
      historyId: "h1",
      internalDate: 0,
      from: "a@b.com",
      to: "c@d.com",
      subject: "Test",
      date: "",
      messageId: "",
      bodyPlain: "Plain text body",
      bodyHtml: "<p>HTML body</p>",
      snippet: "Snippet",
      attachments: [],
      sizeEstimate: 0,
    };

    expect(bodyToMarkdown(msg)).toBe("Plain text body");
  });

  it("converts HTML to markdown when no plain text (priority 2)", () => {
    const msg: GmailMessage = {
      id: "m2",
      threadId: "t2",
      labelIds: [],
      historyId: "h2",
      internalDate: 0,
      from: "a@b.com",
      to: "c@d.com",
      subject: "Test",
      date: "",
      messageId: "",
      bodyHtml:
        "<h1>Title</h1><p>Paragraph with <strong>bold</strong> text.</p>",
      snippet: "Snippet",
      attachments: [],
      sizeEstimate: 0,
    };

    const result = bodyToMarkdown(msg);
    expect(result).toContain("Title");
    expect(result).toContain("**bold**");
    expect(result).toContain("Paragraph with");
  });

  it("falls back to snippet when no plain or HTML (priority 3)", () => {
    const msg: GmailMessage = {
      id: "m3",
      threadId: "t3",
      labelIds: [],
      historyId: "h3",
      internalDate: 0,
      from: "a@b.com",
      to: "c@d.com",
      subject: "Test",
      date: "",
      messageId: "",
      snippet: "This is the snippet fallback",
      attachments: [],
      sizeEstimate: 0,
    };

    expect(bodyToMarkdown(msg)).toBe("This is the snippet fallback");
  });

  it("returns empty string when everything is empty", () => {
    const msg: GmailMessage = {
      id: "m4",
      threadId: "t4",
      labelIds: [],
      historyId: "h4",
      internalDate: 0,
      from: "",
      to: "",
      subject: "",
      date: "",
      messageId: "",
      snippet: "",
      attachments: [],
      sizeEstimate: 0,
    };

    expect(bodyToMarkdown(msg)).toBe("");
  });

  it("converts HTML links to markdown links", () => {
    const msg: GmailMessage = {
      id: "m5",
      threadId: "t5",
      labelIds: [],
      historyId: "h5",
      internalDate: 0,
      from: "a@b.com",
      to: "c@d.com",
      subject: "Links",
      date: "",
      messageId: "",
      bodyHtml: '<a href="https://example.com">Click here</a>',
      snippet: "",
      attachments: [],
      sizeEstimate: 0,
    };

    const result = bodyToMarkdown(msg);
    expect(result).toContain("[Click here](https://example.com)");
  });

  it("converts HTML lists to markdown", () => {
    const msg: GmailMessage = {
      id: "m6",
      threadId: "t6",
      labelIds: [],
      historyId: "h6",
      internalDate: 0,
      from: "a@b.com",
      to: "c@d.com",
      subject: "Lists",
      date: "",
      messageId: "",
      bodyHtml: "<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>",
      snippet: "",
      attachments: [],
      sizeEstimate: 0,
    };

    const result = bodyToMarkdown(msg);
    // Turndown indents list items: "-   Item"
    expect(result).toContain("Item 1");
    expect(result).toContain("Item 2");
    expect(result).toContain("Item 3");
    // Verify it uses the configured bullet marker
    expect(result).toContain("-");
  });

  it("converts HTML headings to ATX-style markdown", () => {
    const msg: GmailMessage = {
      id: "m7",
      threadId: "t7",
      labelIds: [],
      historyId: "h7",
      internalDate: 0,
      from: "a@b.com",
      to: "c@d.com",
      subject: "Headings",
      date: "",
      messageId: "",
      bodyHtml: "<h1>H1</h1><h2>H2</h2><h3>H3</h3>",
      snippet: "",
      attachments: [],
      sizeEstimate: 0,
    };

    const result = bodyToMarkdown(msg);
    expect(result).toContain("# H1");
    expect(result).toContain("## H2");
    expect(result).toContain("### H3");
  });

  it("converts code blocks in HTML to fenced markdown code blocks", () => {
    const msg: GmailMessage = {
      id: "m8",
      threadId: "t8",
      labelIds: [],
      historyId: "h8",
      internalDate: 0,
      from: "a@b.com",
      to: "c@d.com",
      subject: "Code",
      date: "",
      messageId: "",
      bodyHtml: "<pre><code>const x = 42;</code></pre>",
      snippet: "",
      attachments: [],
      sizeEstimate: 0,
    };

    const result = bodyToMarkdown(msg);
    expect(result).toContain("const x = 42;");
    // Turndown fenced code blocks use triple backticks
    expect(result).toContain("```");
  });

  it("prefers bodyPlain even when it is whitespace-only", () => {
    const msg: GmailMessage = {
      id: "m9",
      threadId: "t9",
      labelIds: [],
      historyId: "h9",
      internalDate: 0,
      from: "a@b.com",
      to: "c@d.com",
      subject: "Whitespace",
      date: "",
      messageId: "",
      bodyPlain: "   ",
      bodyHtml: "<p>Real content</p>",
      snippet: "snippet",
      attachments: [],
      sizeEstimate: 0,
    };

    // bodyPlain is truthy ("   "), so it takes priority
    expect(bodyToMarkdown(msg)).toBe("   ");
  });
});

// ─── Base64url decoding edge cases (via walkParts) ───

describe("walkParts - charset handling", () => {
  it("decodes standard UTF-8 content correctly", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
      body: {
        size: 20,
        data: b64url("Hello, world! Caf\u00e9"),
      },
    };

    const result = walkParts(payload);
    expect(result.plain).toBe("Hello, world! Caf\u00e9");
  });

  it("handles ASCII charset (mapped to utf-8)", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: "text/plain; charset=ascii" }],
      body: {
        size: 5,
        data: b64url("Hello"),
      },
    };

    const result = walkParts(payload);
    expect(result.plain).toBe("Hello");
  });

  it("handles content-type with quoted charset", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      headers: [
        {
          name: "Content-Type",
          value: 'text/plain; charset="utf-8"',
        },
      ],
      body: {
        size: 5,
        data: b64url("Hello"),
      },
    };

    const result = walkParts(payload);
    expect(result.plain).toBe("Hello");
  });

  it("falls back to utf-8 for missing content-type header", () => {
    const payload: gmail_v1.Schema$MessagePart = {
      mimeType: "text/plain",
      body: {
        size: 5,
        data: b64url("Hello"),
      },
    };

    const result = walkParts(payload);
    expect(result.plain).toBe("Hello");
  });
});

// ─── Integration-level test ───

describe("parseMessage + bodyToMarkdown integration", () => {
  it("round-trips a simple message to markdown", () => {
    const raw = makeSimpleTextMessage();
    const parsed = parseMessage(raw);
    const markdown = bodyToMarkdown(parsed);
    expect(markdown).toBe("Hello world");
  });

  it("round-trips a multipart message, using plain text priority", () => {
    const raw = makeMultipartMessage();
    const parsed = parseMessage(raw);
    const markdown = bodyToMarkdown(parsed);
    // plain text is available, so it takes priority over HTML
    expect(markdown).toBe("Rich email");
  });

  it("round-trips an HTML-only message to markdown", () => {
    const raw = makeMultipartRelatedMessage();
    const parsed = parseMessage(raw);
    // This message has no text/plain, only text/html
    expect(parsed.bodyPlain).toBeUndefined();
    expect(parsed.bodyHtml).toBeTruthy();
    const markdown = bodyToMarkdown(parsed);
    // Should contain markdown-converted HTML
    expect(markdown).toContain("Look at this");
  });
});
