/**
 * Notion adapter — type definitions.
 *
 * These are the internal types used by the Notion adapter to track sync state,
 * page metadata, and recursive block trees.
 */

// ─── Notion Sync State (stored in AdapterState.metadata) ───

export interface NotionSyncMetadata {
  /** All page IDs known from previous sync (for deletion detection). */
  knownPageIds: string[];
  /** All database IDs known from previous sync. */
  knownDatabaseIds: string[];
  /** Per-page last_edited_time — used to skip unchanged pages on incremental. */
  pageLastEdited: Record<string, string>;
  /** Per-database last_edited_time. */
  dbLastEdited: Record<string, string>;
  /** Cached user info keyed by user ID. */
  userCache: Record<string, NotionUserInfo>;
}

export interface NotionUserInfo {
  name: string;
  email?: string;
  avatarUrl?: string;
  type: "person" | "bot";
}

// ─── Page Metadata ───

export interface PageMeta {
  id: string;
  title: string;
  url: string;
  parentId: string | null;
  parentType: "workspace" | "page_id" | "database_id" | "block_id";
  createdTime: string;
  lastEditedTime: string;
  createdBy: string;
  lastEditedBy: string;
  archived: boolean;
  icon?: PageIcon;
  cover?: PageCover;
  /** Only present for database rows — the row property values. */
  properties?: Record<string, unknown>;
}

export interface PageIcon {
  type: "emoji" | "external" | "file";
  emoji?: string;
  url?: string;
}

export interface PageCover {
  type: "external" | "file";
  url: string;
}

// ─── Database Schema ───

export interface DatabaseMeta {
  id: string;
  title: string;
  url: string;
  parentId: string | null;
  parentType: "workspace" | "page_id" | "block_id";
  createdTime: string;
  lastEditedTime: string;
  archived: boolean;
  icon?: PageIcon;
  cover?: PageCover;
  properties: Record<string, DatabaseProperty>;
}

export interface DatabaseProperty {
  id: string;
  name: string;
  type: string;
  config: unknown;
}

// ─── Block Tree ───

export interface BlockTree {
  id: string;
  type: string;
  hasChildren: boolean;
  children: BlockTree[];
  /** Raw block-type-specific content from the Notion API. */
  content: Record<string, unknown>;
  /** The parent block ID, if any. */
  parentId?: string;
}

// ─── Notion API Response Types (subset we actually use) ───

export interface NotionRichText {
  type: "text" | "mention" | "equation";
  plain_text: string;
  href: string | null;
  annotations: NotionAnnotations;
  text?: { content: string; link: { url: string } | null };
  mention?: unknown;
  equation?: { expression: string };
}

export interface NotionAnnotations {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  underline: boolean;
  code: boolean;
  color: string;
}

export interface NotionFile {
  type: "file" | "external";
  file?: { url: string; expiry_time: string };
  external?: { url: string };
  name?: string;
  caption?: NotionRichText[];
}

// ─── Comment ───

export interface NotionComment {
  id: string;
  createdTime: string;
  createdBy: string;
  richText: NotionRichText[];
  parentType: "page_id" | "block_id";
  parentId: string;
}

// ─── Page tree node for directory structure building ───

export interface PageTreeNode {
  id: string;
  title: string;
  slug: string;
  parentId: string | null;
  parentType: "workspace" | "page_id" | "database_id" | "block_id";
  objectType: "page" | "database";
  lastEditedTime: string;
  archived: boolean;
  children: PageTreeNode[];
  /** Filesystem path relative to outputDir. */
  outputPath: string;
}
