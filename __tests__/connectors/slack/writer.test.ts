import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OutputWriter } from "../../../src/connectors/core/index.js";
import { createOutputWriter } from "../../../src/connectors/core/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ChannelExportData,
  ChannelMap,
  SlackChannel,
  SlackMessage,
  SlackUser,
  UserMap,
} from "../../../src/connectors/slack/types.js";
import {
  writeChannelOutput,
  writeChannelsIndex,
  writeUsersIndex,
} from "../../../src/connectors/slack/writer.js";

// ─── Helpers ───

function makeUser(overrides: Partial<SlackUser> = {}): SlackUser {
  return {
    id: "U001",
    name: "jdoe",
    realName: "John Doe",
    displayName: "johnd",
    email: "john@example.com",
    isBot: false,
    isDeleted: false,
    avatar72: "https://example.com/avatar.png",
    ...overrides,
  };
}

function makeChannel(overrides: Partial<SlackChannel> = {}): SlackChannel {
  return {
    id: "C001",
    name: "general",
    type: "public",
    topic: "General discussion",
    purpose: "A place for general talk",
    memberCount: 50,
    isArchived: false,
    created: 1672531200,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return {
    ts: "1672531200.000000",
    channelId: "C001",
    userId: "U001",
    text: "Hello world",
    ...overrides,
  };
}

function makeUserMap(...users: SlackUser[]): UserMap {
  const map = new Map<string, SlackUser>();
  for (const u of users) map.set(u.id, u);
  return map;
}

function makeChannelMap(...channels: SlackChannel[]): ChannelMap {
  const map = new Map<string, SlackChannel>();
  for (const c of channels) map.set(c.id, c);
  return map;
}

function readFile(tmpDir: string, ...segments: string[]): string {
  return fs.readFileSync(path.join(tmpDir, ...segments), "utf-8");
}

function readJson(tmpDir: string, ...segments: string[]): unknown {
  return JSON.parse(readFile(tmpDir, ...segments));
}

function fileExists(tmpDir: string, ...segments: string[]): boolean {
  return fs.existsSync(path.join(tmpDir, ...segments));
}

// ─── Test Suite ───

describe("writeChannelOutput", () => {
  let tmpDir: string;
  let writer: OutputWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-writer-test-"));
    writer = createOutputWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes messages.md, messages.jsonl, and _meta.json for a channel", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const userMap = makeUserMap(user);
    const channelMap = makeChannelMap(channel);

    const messages: SlackMessage[] = [
      makeMessage({ ts: "1672531200.000000", userId: "U001", text: "Hello!" }),
      makeMessage({ ts: "1672531260.000000", userId: "U001", text: "World!" }),
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    // messages.md
    expect(fileExists(tmpDir, "channels/general/messages.md")).toBe(true);
    const md = readFile(tmpDir, "channels/general/messages.md");
    expect(md).toContain("---"); // frontmatter delimiters
    expect(md).toContain("channel: general");
    expect(md).toContain("Alice");
    expect(md).toContain("Hello!");
    expect(md).toContain("World!");

    // messages.jsonl
    expect(fileExists(tmpDir, "channels/general/messages.jsonl")).toBe(true);
    const jsonlContent = readFile(tmpDir, "channels/general/messages.jsonl");
    const jsonlLines = jsonlContent.trim().split("\n");
    expect(jsonlLines).toHaveLength(2);
    const record1 = JSON.parse(jsonlLines[0]!);
    expect(record1.ts).toBe("1672531200.000000");
    expect(record1.userName).toBe("Alice");
    expect(record1.text).toBe("Hello!");
    const record2 = JSON.parse(jsonlLines[1]!);
    expect(record2.ts).toBe("1672531260.000000");
    expect(record2.text).toBe("World!");

    // _meta.json
    expect(fileExists(tmpDir, "channels/general/_meta.json")).toBe(true);
    const meta = readJson(tmpDir, "channels/general/_meta.json") as Record<
      string,
      unknown
    >;
    expect(meta.channelId).toBe("C001");
    expect(meta.channelName).toBe("general");
    expect(meta.type).toBe("public");
    expect(meta.messageCount).toBe(2);
  });

  it("writes date-grouped headers in messages.md", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const userMap = makeUserMap(user);
    const channelMap = makeChannelMap(channel);

    // Messages spanning two days
    const messages: SlackMessage[] = [
      makeMessage({ ts: "1672531200.000000", text: "Day 1 msg" }), // 2023-01-01
      makeMessage({ ts: "1672617600.000000", text: "Day 2 msg" }), // 2023-01-02
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const md = readFile(tmpDir, "channels/general/messages.md");
    expect(md).toContain("## 2023-01-01");
    expect(md).toContain("## 2023-01-02");
    expect(md).toContain("Day 1 msg");
    expect(md).toContain("Day 2 msg");
  });

  it("handles empty messages array", async () => {
    const channel = makeChannel({ id: "C001", name: "empty-channel" });
    const userMap = makeUserMap();
    const channelMap = makeChannelMap(channel);

    const data: ChannelExportData = {
      channel,
      slug: "empty-channel",
      messages: [],
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const md = readFile(tmpDir, "channels/empty-channel/messages.md");
    expect(md).toContain("_No messages._");

    const meta = readJson(
      tmpDir,
      "channels/empty-channel/_meta.json",
    ) as Record<string, unknown>;
    expect(meta.messageCount).toBe(0);
    expect(meta.oldestMessage).toBeNull();
    expect(meta.newestMessage).toBeNull();
  });

  it("skips deleted messages in JSONL output", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const userMap = makeUserMap(user);
    const channelMap = makeChannelMap(channel);

    const messages: SlackMessage[] = [
      makeMessage({ ts: "1672531200.000000", text: "Normal msg" }),
      makeMessage({
        ts: "1672531260.000000",
        text: "",
        subtype: "message_deleted",
      }),
      makeMessage({ ts: "1672531320.000000", text: "Another msg" }),
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const jsonlContent = readFile(tmpDir, "channels/general/messages.jsonl");
    const jsonlLines = jsonlContent.trim().split("\n");
    // Should only include non-deleted messages
    expect(jsonlLines).toHaveLength(2);
    expect(JSON.parse(jsonlLines[0]!).text).toBe("Normal msg");
    expect(JSON.parse(jsonlLines[1]!).text).toBe("Another msg");

    // Meta should also exclude deleted messages
    const meta = readJson(tmpDir, "channels/general/_meta.json") as Record<
      string,
      unknown
    >;
    expect(meta.messageCount).toBe(2);
  });

  it("includes reactions in messages.md", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const userMap = makeUserMap(user);
    const channelMap = makeChannelMap(channel);

    const messages: SlackMessage[] = [
      makeMessage({
        ts: "1672531200.000000",
        text: "Great news!",
        reactions: [
          { name: "thumbsup", count: 3, users: ["U001", "U002", "U003"] },
          { name: "heart", count: 1, users: ["U002"] },
        ],
      }),
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const md = readFile(tmpDir, "channels/general/messages.md");
    expect(md).toContain(":thumbsup: (3)");
    expect(md).toContain(":heart: (1)");
  });

  it("includes file attachments in messages.md", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const userMap = makeUserMap(user);
    const channelMap = makeChannelMap(channel);

    const messages: SlackMessage[] = [
      makeMessage({
        ts: "1672531200.000000",
        text: "Here is a file",
        files: [
          {
            id: "F001",
            name: "report.pdf",
            mimetype: "application/pdf",
            size: 1048576, // 1 MB
            urlPrivateDownload: "https://slack.com/files/report.pdf",
            permalink: "https://slack.com/files/report.pdf",
            createdAt: 1672531200,
          },
        ],
      }),
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const md = readFile(tmpDir, "channels/general/messages.md");
    expect(md).toContain("[File: report.pdf (1.0 MB)]");
  });

  it("renders system messages with italics", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const userMap = makeUserMap(user);
    const channelMap = makeChannelMap(channel);

    const messages: SlackMessage[] = [
      makeMessage({
        ts: "1672531200.000000",
        userId: "U001",
        text: "",
        subtype: "channel_join",
      }),
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const md = readFile(tmpDir, "channels/general/messages.md");
    // System messages are now filtered out of messages.md
    expect(md).not.toContain("_Alice joined the channel_");
  });

  it("renders thread replies inline in messages.md", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const alice = makeUser({ id: "U001", displayName: "Alice" });
    const bob = makeUser({ id: "U002", displayName: "Bob" });
    const userMap = makeUserMap(alice, bob);
    const channelMap = makeChannelMap(channel);

    const parentTs = "1672531200.000000";
    const replyTs = "1672531260.000000";

    const messages: SlackMessage[] = [
      makeMessage({
        ts: parentTs,
        userId: "U001",
        text: "Parent message",
        threadTs: parentTs,
        replyCount: 1,
      }),
    ];

    const threads = new Map<string, SlackMessage[]>();
    threads.set(parentTs, [
      makeMessage({ ts: parentTs, userId: "U001", text: "Parent message" }),
      makeMessage({ ts: replyTs, userId: "U002", text: "Reply from Bob" }),
    ]);

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads,
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const md = readFile(tmpDir, "channels/general/messages.md");
    expect(md).toContain("> **Bob**");
    expect(md).toContain("[thread]");
    expect(md).toContain("> Reply from Bob");
  });

  it("writes thread documents as separate .md files", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const alice = makeUser({ id: "U001", displayName: "Alice" });
    const bob = makeUser({ id: "U002", displayName: "Bob" });
    const userMap = makeUserMap(alice, bob);
    const channelMap = makeChannelMap(channel);

    const parentTs = "1672531200.000000";
    const replyTs = "1672531260.000000";

    const messages: SlackMessage[] = [
      makeMessage({ ts: parentTs, userId: "U001", text: "Start thread" }),
    ];

    const threads = new Map<string, SlackMessage[]>();
    threads.set(parentTs, [
      makeMessage({ ts: parentTs, userId: "U001", text: "Start thread" }),
      makeMessage({ ts: replyTs, userId: "U002", text: "Thread reply" }),
    ]);

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads,
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const threadPath = `threads/general/${parentTs}.md`;
    expect(fileExists(tmpDir, threadPath)).toBe(true);

    const threadMd = readFile(tmpDir, threadPath);
    expect(threadMd).toContain('thread_ts: "1672531200.000000"');
    expect(threadMd).toContain("# Thread in #general");
    expect(threadMd).toContain("**Alice** started this thread");
    expect(threadMd).toContain("Start thread");
    expect(threadMd).toContain("**Bob**");
    expect(threadMd).toContain("Thread reply");
  });

  it("populates _meta.json with correct oldest/newest timestamps", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const userMap = makeUserMap(user);
    const channelMap = makeChannelMap(channel);

    const messages: SlackMessage[] = [
      makeMessage({ ts: "1672531200.000000", text: "First" }),
      makeMessage({ ts: "1672617600.000000", text: "Middle" }),
      makeMessage({ ts: "1672704000.000000", text: "Last" }),
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const meta = readJson(tmpDir, "channels/general/_meta.json") as Record<
      string,
      unknown
    >;
    expect(meta.messageCount).toBe(3);
    expect(meta.oldestMessage).toBe("2023-01-01T00:00:00.000Z");
    expect(meta.newestMessage).toBe("2023-01-03T00:00:00.000Z");
    expect(meta.topic).toBe("General discussion");
    expect(meta.purpose).toBe("A place for general talk");
    expect(meta.memberCount).toBe(50);
  });

  it("includes JSONL records with expected fields", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const userMap = makeUserMap(user);
    const channelMap = makeChannelMap(channel);

    const messages: SlackMessage[] = [
      makeMessage({
        ts: "1672531200.000000",
        userId: "U001",
        text: "Test message",
        threadTs: "1672531100.000000",
        reactions: [{ name: "thumbsup", count: 2, users: ["U001", "U002"] }],
        files: [
          {
            id: "F001",
            name: "test.txt",
            mimetype: "text/plain",
            size: 100,
            urlPrivateDownload: "https://slack.com/files/test.txt",
            permalink: "https://slack.com/files/test.txt",
            createdAt: 1672531200,
          },
        ],
        edited: { user: "U001", ts: "1672531300.000000" },
      }),
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const jsonlContent = readFile(tmpDir, "channels/general/messages.jsonl");
    const record = JSON.parse(jsonlContent.trim());

    expect(record.ts).toBe("1672531200.000000");
    expect(record.user).toBe("U001");
    expect(record.userName).toBe("Alice");
    expect(record.text).toBe("Test message");
    expect(record.threadTs).toBe("1672531100.000000");
    expect(record.reactions).toHaveLength(1);
    expect(record.reactions[0].name).toBe("thumbsup");
    expect(record.files).toHaveLength(1);
    expect(record.files[0].name).toBe("test.txt");
    expect(record.files[0].size).toBe(100);
    expect(record.edited).toEqual({ user: "U001", ts: "1672531300.000000" });
    expect(record.date).toBe("2023-01-01T00:00:00.000Z");
  });

  it("handles JSONL records with null optional fields", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const userMap = makeUserMap(user);
    const channelMap = makeChannelMap(channel);

    const messages: SlackMessage[] = [
      makeMessage({
        ts: "1672531200.000000",
        userId: "U001",
        text: "Bare message",
        // no threadTs, reactions, files, or edited
      }),
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const jsonlContent = readFile(tmpDir, "channels/general/messages.jsonl");
    const record = JSON.parse(jsonlContent.trim());

    expect(record.threadTs).toBeNull();
    expect(record.reactions).toEqual([]);
    expect(record.files).toEqual([]);
    expect(record.edited).toBeNull();
  });

  it("resolves mentions in written output", async () => {
    const channel = makeChannel({ id: "C001", name: "general" });
    const alice = makeUser({ id: "U001", displayName: "Alice" });
    const bob = makeUser({ id: "U002", displayName: "Bob" });
    const userMap = makeUserMap(alice, bob);
    const channelMap = makeChannelMap(channel);

    const messages: SlackMessage[] = [
      makeMessage({
        ts: "1672531200.000000",
        userId: "U001",
        text: "Hey <@U002>, check <#C001|general>",
      }),
    ];

    const data: ChannelExportData = {
      channel,
      slug: "general",
      messages,
      threads: new Map(),
      userMap,
    };

    await writeChannelOutput(writer, data, channelMap);

    const md = readFile(tmpDir, "channels/general/messages.md");
    expect(md).toContain("@Bob");
    expect(md).toContain("#general");
    // Should not contain raw Slack mention syntax
    expect(md).not.toContain("<@U002>");
    expect(md).not.toContain("<#C001|");
  });
});

// ─── writeUsersIndex ───

describe("writeUsersIndex", () => {
  let tmpDir: string;
  let writer: OutputWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-writer-users-"));
    writer = createOutputWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes _meta/users.json with all users", async () => {
    const alice = makeUser({
      id: "U001",
      name: "alice",
      displayName: "Alice",
      email: "alice@co.com",
    });
    const bob = makeUser({
      id: "U002",
      name: "bob",
      displayName: "Bob",
      isBot: true,
    });
    const userMap = makeUserMap(alice, bob);

    await writeUsersIndex(writer, userMap);

    expect(fileExists(tmpDir, "_meta/users.json")).toBe(true);
    const data = readJson(tmpDir, "_meta/users.json") as {
      users: Record<string, unknown>[];
    };
    expect(data.users).toHaveLength(2);

    const ids = data.users.map((u) => u.id);
    expect(ids).toContain("U001");
    expect(ids).toContain("U002");

    const aliceRecord = data.users.find((u) => u.id === "U001") as Record<
      string,
      unknown
    >;
    expect(aliceRecord.name).toBe("alice");
    expect(aliceRecord.displayName).toBe("Alice");
    expect(aliceRecord.email).toBe("alice@co.com");
    expect(aliceRecord.isBot).toBe(false);
    expect(aliceRecord.isDeleted).toBe(false);

    const bobRecord = data.users.find((u) => u.id === "U002") as Record<
      string,
      unknown
    >;
    expect(bobRecord.isBot).toBe(true);
  });

  it("writes an empty users array for an empty userMap", async () => {
    const userMap = makeUserMap();

    await writeUsersIndex(writer, userMap);

    const data = readJson(tmpDir, "_meta/users.json") as { users: unknown[] };
    expect(data.users).toEqual([]);
  });

  it("excludes avatar72 from written user data", async () => {
    const user = makeUser({
      id: "U001",
      avatar72: "https://example.com/avatar.png",
    });
    const userMap = makeUserMap(user);

    await writeUsersIndex(writer, userMap);

    const data = readJson(tmpDir, "_meta/users.json") as {
      users: Record<string, unknown>[];
    };
    const record = data.users[0]!;
    expect(record).not.toHaveProperty("avatar72");
  });

  it("includes optional email when present", async () => {
    const userWithEmail = makeUser({ id: "U001", email: "test@example.com" });
    const userWithoutEmail = makeUser({ id: "U002", email: undefined });
    const userMap = makeUserMap(userWithEmail, userWithoutEmail);

    await writeUsersIndex(writer, userMap);

    const data = readJson(tmpDir, "_meta/users.json") as {
      users: Record<string, unknown>[];
    };
    const user1 = data.users.find((u) => u.id === "U001") as Record<
      string,
      unknown
    >;
    const user2 = data.users.find((u) => u.id === "U002") as Record<
      string,
      unknown
    >;
    expect(user1.email).toBe("test@example.com");
    expect(user2.email).toBeUndefined();
  });
});

// ─── writeChannelsIndex ───

describe("writeChannelsIndex", () => {
  let tmpDir: string;
  let writer: OutputWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-writer-channels-"));
    writer = createOutputWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes _meta/channels.json with channel data", async () => {
    const channels: SlackChannel[] = [
      makeChannel({
        id: "C001",
        name: "general",
        type: "public",
        memberCount: 50,
        isArchived: false,
      }),
      makeChannel({
        id: "C002",
        name: "random",
        type: "public",
        memberCount: 30,
        isArchived: false,
      }),
    ];

    const slugMap = new Map<string, string>();
    slugMap.set("C001", "general");
    slugMap.set("C002", "random");

    await writeChannelsIndex(writer, channels, slugMap);

    expect(fileExists(tmpDir, "_meta/channels.json")).toBe(true);
    const data = readJson(tmpDir, "_meta/channels.json") as {
      channels: Record<string, unknown>[];
    };
    expect(data.channels).toHaveLength(2);

    const ch1 = data.channels[0]!;
    expect(ch1.id).toBe("C001");
    expect(ch1.name).toBe("general");
    expect(ch1.slug).toBe("general");
    expect(ch1.type).toBe("public");
    expect(ch1.memberCount).toBe(50);

    const ch2 = data.channels[1]!;
    expect(ch2.id).toBe("C002");
    expect(ch2.name).toBe("random");
    expect(ch2.slug).toBe("random");
  });

  it("uses channel name as fallback when slug is missing from slugMap", async () => {
    const channels: SlackChannel[] = [
      makeChannel({ id: "C001", name: "no-slug-channel" }),
    ];

    // Empty slugMap, so the fallback should be the channel name
    const slugMap = new Map<string, string>();

    await writeChannelsIndex(writer, channels, slugMap);

    const data = readJson(tmpDir, "_meta/channels.json") as {
      channels: Record<string, unknown>[];
    };
    expect(data.channels[0]?.slug).toBe("no-slug-channel");
  });

  it("writes an empty channels array when no channels are provided", async () => {
    await writeChannelsIndex(writer, [], new Map());

    const data = readJson(tmpDir, "_meta/channels.json") as {
      channels: unknown[];
    };
    expect(data.channels).toEqual([]);
  });

  it("includes topic and purpose in channel records", async () => {
    const channels: SlackChannel[] = [
      makeChannel({
        id: "C001",
        name: "engineering",
        topic: "Engineering discussions",
        purpose: "For the engineering team",
      }),
    ];

    const slugMap = new Map([["C001", "engineering"]]);

    await writeChannelsIndex(writer, channels, slugMap);

    const data = readJson(tmpDir, "_meta/channels.json") as {
      channels: Record<string, unknown>[];
    };
    const ch = data.channels[0]!;
    expect(ch.topic).toBe("Engineering discussions");
    expect(ch.purpose).toBe("For the engineering team");
  });

  it("includes isArchived flag", async () => {
    const channels: SlackChannel[] = [
      makeChannel({ id: "C001", name: "active", isArchived: false }),
      makeChannel({ id: "C002", name: "old-stuff", isArchived: true }),
    ];

    const slugMap = new Map([
      ["C001", "active"],
      ["C002", "old-stuff"],
    ]);

    await writeChannelsIndex(writer, channels, slugMap);

    const data = readJson(tmpDir, "_meta/channels.json") as {
      channels: Record<string, unknown>[];
    };
    expect(data.channels[0]?.isArchived).toBe(false);
    expect(data.channels[1]?.isArchived).toBe(true);
  });

  it("handles channels with different types", async () => {
    const channels: SlackChannel[] = [
      makeChannel({ id: "C001", name: "public-ch", type: "public" }),
      makeChannel({ id: "C002", name: "private-ch", type: "private" }),
      makeChannel({ id: "C003", name: "dm-ch", type: "im" }),
      makeChannel({ id: "C004", name: "group-dm", type: "mpim" }),
    ];

    const slugMap = new Map([
      ["C001", "public-ch"],
      ["C002", "private-ch"],
      ["C003", "dm-ch"],
      ["C004", "group-dm"],
    ]);

    await writeChannelsIndex(writer, channels, slugMap);

    const data = readJson(tmpDir, "_meta/channels.json") as {
      channels: Record<string, unknown>[];
    };
    expect(data.channels).toHaveLength(4);
    expect(data.channels[0]?.type).toBe("public");
    expect(data.channels[1]?.type).toBe("private");
    expect(data.channels[2]?.type).toBe("im");
    expect(data.channels[3]?.type).toBe("mpim");
  });
});
