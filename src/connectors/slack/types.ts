/** Slack-specific type definitions for the saas-mirror Slack adapter. */

// ─── Core Slack Entities ───

export interface SlackChannel {
  id: string;
  name: string;
  type: "public" | "private" | "im" | "mpim";
  topic: string;
  purpose: string;
  memberCount: number;
  isArchived: boolean;
  created: number;
}

export interface SlackUser {
  id: string;
  name: string;
  realName: string;
  displayName: string;
  email?: string;
  isBot: boolean;
  isDeleted: boolean;
  avatar72: string;
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  urlPrivateDownload: string;
  permalink: string;
  createdAt: number;
}

export interface SlackMessage {
  ts: string;
  channelId: string;
  userId: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  replyCount?: number;
  reactions?: SlackReaction[];
  files?: SlackFile[];
  edited?: { user: string; ts: string };
  subtype?: string;
  botId?: string;
  botProfile?: { name: string };
  username?: string;
}

// ─── Sync State Metadata ───

export interface SlackSyncMetadata {
  /** Per-channel: ts of newest message seen. channelId -> latest ts */
  channelHighWaterMark: Record<string, string>;
  /** Per-thread: ts of latest reply seen. threadTs -> latest reply ts */
  threadHighWaterMark: Record<string, string>;
  /** Last full channel list refresh ISO string */
  lastChannelListAt: string | null;
  /** Known channel IDs (to detect new/removed) */
  knownChannelIds: string[];
  /** User list last refreshed ISO string */
  lastUsersRefreshAt: string | null;
  /** Channels fully hydrated (for resuming interrupted full sync) */
  hydratedChannels: string[];
  /** Channels that failed last run (retry these) */
  failedChannels: string[];
}

// ─── Lookup Maps ───

export type UserMap = Map<string, SlackUser>;
export type ChannelMap = Map<string, SlackChannel>;

// ─── Auth Info ───

export interface SlackAuthInfo {
  teamId: string;
  teamName: string;
  userId: string;
  botId?: string;
}

// ─── Writer Input Types ───

export interface ChannelExportData {
  channel: SlackChannel;
  slug: string;
  messages: SlackMessage[];
  threads: Map<string, SlackMessage[]>;
  userMap: UserMap;
}

export interface JsonlRecord {
  ts: string;
  user: string;
  userName: string;
  text: string;
  threadTs: string | null;
  reactions: SlackReaction[];
  files: Array<{ id: string; name: string; mimetype: string; size: number }>;
  edited: { user: string; ts: string } | null;
  date: string;
}
