import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatTime,
  formatTimestamp,
  getAuthorName,
  isSystemMessage,
  mrkdwnToMarkdown,
  resolveMentions,
} from "../../../src/connectors/slack/transform.js";
import type {
  ChannelMap,
  SlackChannel,
  SlackMessage,
  SlackUser,
  UserMap,
} from "../../../src/connectors/slack/types.js";

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

// ─── resolveMentions ───

describe("resolveMentions", () => {
  const user1 = makeUser({ id: "U001", name: "alice", displayName: "Alice" });
  const user2 = makeUser({
    id: "U002",
    name: "bob",
    displayName: "Bob",
    realName: "Bob Smith",
  });
  const userMap = makeUserMap(user1, user2);

  const channel1 = makeChannel({ id: "C001", name: "general" });
  const channel2 = makeChannel({ id: "C002", name: "random" });
  const channelMap = makeChannelMap(channel1, channel2);

  describe("user mentions", () => {
    it("resolves a known user mention by displayName", () => {
      const result = resolveMentions("Hey <@U001>!", userMap, channelMap);
      expect(result).toBe("Hey @Alice!");
    });

    it("resolves multiple user mentions", () => {
      const result = resolveMentions(
        "<@U001> and <@U002> are here",
        userMap,
        channelMap,
      );
      expect(result).toBe("@Alice and @Bob are here");
    });

    it("preserves display override when provided in mention", () => {
      const result = resolveMentions(
        "cc <@U001|custom_name>",
        userMap,
        channelMap,
      );
      expect(result).toBe("cc @custom_name");
    });

    it("falls back to user ID for unknown users", () => {
      const result = resolveMentions("Hi <@UUNKNOWN>", userMap, channelMap);
      expect(result).toBe("Hi @UUNKNOWN");
    });

    it("resolves user with displayName empty, falls back to name", () => {
      const userNoDisplay = makeUser({
        id: "U003",
        name: "charlie",
        displayName: "",
      });
      const map = makeUserMap(userNoDisplay);
      const result = resolveMentions("Hey <@U003>", map, channelMap);
      expect(result).toBe("Hey @charlie");
    });
  });

  describe("channel mentions", () => {
    it("resolves channel mention with display label", () => {
      const result = resolveMentions(
        "See <#C001|general>",
        userMap,
        channelMap,
      );
      expect(result).toBe("See #general");
    });

    it("resolves channel mention without display label using channelMap", () => {
      const result = resolveMentions("Go to <#C002>", userMap, channelMap);
      expect(result).toBe("Go to #random");
    });

    it("falls back to channel ID for unknown channels", () => {
      const result = resolveMentions("See <#CUNKNOWN>", userMap, channelMap);
      expect(result).toBe("See #CUNKNOWN");
    });

    it("resolves multiple channel mentions", () => {
      const result = resolveMentions(
        "<#C001|general> and <#C002|random>",
        userMap,
        channelMap,
      );
      expect(result).toBe("#general and #random");
    });
  });

  describe("URL resolution", () => {
    it("resolves a plain URL", () => {
      const result = resolveMentions(
        "Visit <https://example.com>",
        userMap,
        channelMap,
      );
      expect(result).toBe("Visit https://example.com");
    });

    it("resolves a URL with a label to markdown link", () => {
      const result = resolveMentions(
        "Check <https://example.com|Example Site>",
        userMap,
        channelMap,
      );
      expect(result).toBe("Check [Example Site](https://example.com)");
    });

    it("resolves http URLs (not just https)", () => {
      const result = resolveMentions(
        "Go to <http://legacy.local>",
        userMap,
        channelMap,
      );
      expect(result).toBe("Go to http://legacy.local");
    });

    it("handles URLs with query parameters and fragments", () => {
      const result = resolveMentions(
        "See <https://example.com/page?q=1&r=2#section>",
        userMap,
        channelMap,
      );
      expect(result).toBe("See https://example.com/page?q=1&r=2#section");
    });
  });

  describe("email/mailto resolution", () => {
    it("resolves mailto with label", () => {
      const result = resolveMentions(
        "Email <mailto:user@example.com|user@example.com>",
        userMap,
        channelMap,
      );
      expect(result).toBe("Email user@example.com");
    });

    it("resolves mailto without label", () => {
      const result = resolveMentions(
        "Email <mailto:admin@test.org>",
        userMap,
        channelMap,
      );
      expect(result).toBe("Email admin@test.org");
    });
  });

  describe("special mentions", () => {
    it("resolves <!here>", () => {
      const result = resolveMentions("<!here> listen up", userMap, channelMap);
      expect(result).toBe("@here listen up");
    });

    it("resolves <!channel>", () => {
      const result = resolveMentions(
        "<!channel> important",
        userMap,
        channelMap,
      );
      expect(result).toBe("@channel important");
    });

    it("resolves <!everyone>", () => {
      const result = resolveMentions(
        "<!everyone> meeting now",
        userMap,
        channelMap,
      );
      expect(result).toBe("@everyone meeting now");
    });

    it("resolves subteam mention with label", () => {
      const result = resolveMentions(
        "Hey <!subteam^S12345|engineering>",
        userMap,
        channelMap,
      );
      expect(result).toBe("Hey @engineering");
    });

    it("resolves subteam mention without label", () => {
      const result = resolveMentions(
        "Hey <!subteam^S12345>",
        userMap,
        channelMap,
      );
      expect(result).toBe("Hey @group");
    });
  });

  describe("mixed content", () => {
    it("resolves a message with mixed mention types", () => {
      const text =
        "<@U001> posted in <#C001|general>: check <https://example.com|this> <!here>";
      const result = resolveMentions(text, userMap, channelMap);
      expect(result).toBe(
        "@Alice posted in #general: check [this](https://example.com) @here",
      );
    });

    it("handles empty text", () => {
      const result = resolveMentions("", userMap, channelMap);
      expect(result).toBe("");
    });

    it("handles text with no mentions", () => {
      const result = resolveMentions(
        "Just a plain message",
        userMap,
        channelMap,
      );
      expect(result).toBe("Just a plain message");
    });
  });
});

// ─── mrkdwnToMarkdown ───

describe("mrkdwnToMarkdown", () => {
  it("converts single-asterisk bold to double-asterisk bold", () => {
    expect(mrkdwnToMarkdown("this is *bold* text")).toBe(
      "this is **bold** text",
    );
  });

  it("converts tilde strikethrough to double-tilde", () => {
    expect(mrkdwnToMarkdown("this is ~struck~ text")).toBe(
      "this is ~~struck~~ text",
    );
  });

  it("preserves italic underscores (same in both formats)", () => {
    expect(mrkdwnToMarkdown("this is _italic_ text")).toBe(
      "this is _italic_ text",
    );
  });

  it("converts bold and strikethrough in the same string", () => {
    expect(mrkdwnToMarkdown("*bold* and ~strike~")).toBe(
      "**bold** and ~~strike~~",
    );
  });

  it("does not double-convert already-doubled asterisks", () => {
    expect(mrkdwnToMarkdown("already **bold** text")).toBe(
      "already **bold** text",
    );
  });

  it("does not double-convert already-doubled tildes", () => {
    expect(mrkdwnToMarkdown("already ~~struck~~ text")).toBe(
      "already ~~struck~~ text",
    );
  });

  it("handles multiple bold sections", () => {
    expect(mrkdwnToMarkdown("*one* and *two*")).toBe("**one** and **two**");
  });

  it("handles multiple strikethrough sections", () => {
    expect(mrkdwnToMarkdown("~one~ and ~two~")).toBe("~~one~~ and ~~two~~");
  });

  it("returns empty string unchanged", () => {
    expect(mrkdwnToMarkdown("")).toBe("");
  });

  it("does not convert asterisks spanning newlines", () => {
    // Slack mrkdwn bold does not span lines
    const input = "*line1\nline2*";
    expect(mrkdwnToMarkdown(input)).toBe("*line1\nline2*");
  });

  it("does not convert tildes spanning newlines", () => {
    const input = "~line1\nline2~";
    expect(mrkdwnToMarkdown(input)).toBe("~line1\nline2~");
  });

  it("handles plain text with no formatting", () => {
    expect(mrkdwnToMarkdown("just some plain text")).toBe(
      "just some plain text",
    );
  });
});

// ─── formatTimestamp ───

describe("formatTimestamp", () => {
  it("formats a valid Slack timestamp to ISO string", () => {
    // 1672531200 = 2023-01-01T00:00:00.000Z
    const result = formatTimestamp("1672531200.000000");
    expect(result).toBe("2023-01-01T00:00:00.000Z");
  });

  it("handles timestamps with fractional parts", () => {
    const result = formatTimestamp("1672531200.123456");
    // The fractional part after the dot is Slack's message ordering, not sub-seconds,
    // but parseFloat will interpret "1672531200.123456" as that float.
    const expected = new Date(1672531200.123456 * 1000).toISOString();
    expect(result).toBe(expected);
  });

  it("returns the original string for non-numeric input", () => {
    expect(formatTimestamp("not-a-number")).toBe("not-a-number");
  });

  it("handles zero timestamp", () => {
    const result = formatTimestamp("0.000000");
    expect(result).toBe("1970-01-01T00:00:00.000Z");
  });

  it("handles very large timestamps", () => {
    // 2000000000 = 2033-05-18T03:33:20.000Z
    const result = formatTimestamp("2000000000.000000");
    expect(result).toBe(new Date(2000000000 * 1000).toISOString());
  });
});

// ─── formatDate ───

describe("formatDate", () => {
  it("extracts date portion from a Slack timestamp", () => {
    const result = formatDate("1672531200.000000");
    expect(result).toBe("2023-01-01");
  });

  it("handles a mid-year date", () => {
    // 1688169600 = 2023-07-01T00:00:00.000Z
    const result = formatDate("1688169600.000000");
    expect(result).toBe("2023-07-01");
  });

  it("returns the original string for non-numeric input", () => {
    expect(formatDate("invalid")).toBe("invalid");
  });

  it("handles epoch zero", () => {
    expect(formatDate("0.000000")).toBe("1970-01-01");
  });
});

// ─── formatTime ───

describe("formatTime", () => {
  it("formats time as locale time string", () => {
    // 1672531200 = 2023-01-01T00:00:00.000Z
    const result = formatTime("1672531200.000000");
    // The exact output depends on the system locale/timezone,
    // but it should match the format "HH:MM AM/PM"
    expect(result).toMatch(/^\d{2}:\d{2}\s[AP]M$/);
  });

  it("returns original string for non-numeric input", () => {
    expect(formatTime("not-a-number")).toBe("not-a-number");
  });

  it("handles epoch zero", () => {
    const result = formatTime("0.000000");
    expect(result).toMatch(/^\d{2}:\d{2}\s[AP]M$/);
  });
});

// ─── isSystemMessage ───

describe("isSystemMessage", () => {
  it("returns true for channel_join", () => {
    expect(isSystemMessage(makeMessage({ subtype: "channel_join" }))).toBe(
      true,
    );
  });

  it("returns true for channel_leave", () => {
    expect(isSystemMessage(makeMessage({ subtype: "channel_leave" }))).toBe(
      true,
    );
  });

  it("returns true for channel_topic", () => {
    expect(isSystemMessage(makeMessage({ subtype: "channel_topic" }))).toBe(
      true,
    );
  });

  it("returns true for channel_purpose", () => {
    expect(isSystemMessage(makeMessage({ subtype: "channel_purpose" }))).toBe(
      true,
    );
  });

  it("returns true for channel_name", () => {
    expect(isSystemMessage(makeMessage({ subtype: "channel_name" }))).toBe(
      true,
    );
  });

  it("returns true for channel_archive", () => {
    expect(isSystemMessage(makeMessage({ subtype: "channel_archive" }))).toBe(
      true,
    );
  });

  it("returns true for channel_unarchive", () => {
    expect(isSystemMessage(makeMessage({ subtype: "channel_unarchive" }))).toBe(
      true,
    );
  });

  it("returns true for pinned_item", () => {
    expect(isSystemMessage(makeMessage({ subtype: "pinned_item" }))).toBe(true);
  });

  it("returns true for unpinned_item", () => {
    expect(isSystemMessage(makeMessage({ subtype: "unpinned_item" }))).toBe(
      true,
    );
  });

  it("returns true for group_join", () => {
    expect(isSystemMessage(makeMessage({ subtype: "group_join" }))).toBe(true);
  });

  it("returns true for group_leave", () => {
    expect(isSystemMessage(makeMessage({ subtype: "group_leave" }))).toBe(true);
  });

  it("returns true for group_topic", () => {
    expect(isSystemMessage(makeMessage({ subtype: "group_topic" }))).toBe(true);
  });

  it("returns true for group_purpose", () => {
    expect(isSystemMessage(makeMessage({ subtype: "group_purpose" }))).toBe(
      true,
    );
  });

  it("returns true for group_name", () => {
    expect(isSystemMessage(makeMessage({ subtype: "group_name" }))).toBe(true);
  });

  it("returns true for group_archive", () => {
    expect(isSystemMessage(makeMessage({ subtype: "group_archive" }))).toBe(
      true,
    );
  });

  it("returns true for group_unarchive", () => {
    expect(isSystemMessage(makeMessage({ subtype: "group_unarchive" }))).toBe(
      true,
    );
  });

  it("returns false for a regular message with no subtype", () => {
    expect(isSystemMessage(makeMessage())).toBe(false);
  });

  it("returns false for subtype=me_message (not a system subtype)", () => {
    expect(isSystemMessage(makeMessage({ subtype: "me_message" }))).toBe(false);
  });

  it("returns false for subtype=bot_message", () => {
    expect(isSystemMessage(makeMessage({ subtype: "bot_message" }))).toBe(
      false,
    );
  });

  it("returns false for subtype=message_deleted", () => {
    expect(isSystemMessage(makeMessage({ subtype: "message_deleted" }))).toBe(
      false,
    );
  });

  it("returns false for subtype=file_share", () => {
    expect(isSystemMessage(makeMessage({ subtype: "file_share" }))).toBe(false);
  });
});

// ─── getAuthorName ───

describe("getAuthorName", () => {
  it("returns displayName when user is in the map", () => {
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const map = makeUserMap(user);
    expect(getAuthorName(makeMessage({ userId: "U001" }), map)).toBe("Alice");
  });

  it("falls back to realName when displayName is empty", () => {
    const user = makeUser({
      id: "U001",
      displayName: "",
      realName: "Alice Real",
    });
    const map = makeUserMap(user);
    expect(getAuthorName(makeMessage({ userId: "U001" }), map)).toBe(
      "Alice Real",
    );
  });

  it("falls back to name when both displayName and realName are empty", () => {
    const user = makeUser({
      id: "U001",
      displayName: "",
      realName: "",
      name: "alice",
    });
    const map = makeUserMap(user);
    expect(getAuthorName(makeMessage({ userId: "U001" }), map)).toBe("alice");
  });

  it("returns username when user is not in map but username is set", () => {
    const map = makeUserMap();
    const msg = makeMessage({ userId: "", username: "webhook-bot" });
    expect(getAuthorName(msg, map)).toBe("webhook-bot");
  });

  it("returns bot:botId when user and username not available, but botId is", () => {
    const map = makeUserMap();
    const msg = makeMessage({
      userId: "",
      username: undefined,
      botId: "B12345",
    });
    expect(getAuthorName(msg, map)).toBe("bot:B12345");
  });

  it("returns 'unknown' when no identifiers are available", () => {
    const map = makeUserMap();
    const msg = makeMessage({
      userId: "",
      username: undefined,
      botId: undefined,
    });
    expect(getAuthorName(msg, map)).toBe("unknown");
  });

  it("prefers user from map over username field", () => {
    const user = makeUser({ id: "U001", displayName: "Alice" });
    const map = makeUserMap(user);
    const msg = makeMessage({ userId: "U001", username: "some-webhook" });
    expect(getAuthorName(msg, map)).toBe("Alice");
  });

  it("falls back to username when userId is set but not found in map", () => {
    const map = makeUserMap();
    const msg = makeMessage({ userId: "U999", username: "fallback-name" });
    // userId is truthy so we check map first, map miss, then fall through.
    // The code checks message.userId -> map lookup. If user not found, it does NOT
    // fall through to username; it continues. Let's verify behavior.
    // Looking at the code: if (message.userId) { map check -> if user found return; }
    // Then: if (message.username) return message.username;
    // So yes, it should fall back to username.
    expect(getAuthorName(msg, map)).toBe("fallback-name");
  });
});
