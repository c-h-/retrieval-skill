/**
 * Gmail adapter type definitions.
 *
 * These are the domain types used internally by the adapter — not the raw
 * googleapis response schemas (those come from `gmail_v1.Schema$*`).
 */

// ─── Label ───

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

// ─── Attachment metadata (stored in message, binary stored separately) ───

export interface AttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Content-ID for inline images (cid: references). */
  contentId?: string;
}

// ─── Parsed message ───

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  historyId: string;
  /** Unix-ms timestamp (Gmail's internalDate). */
  internalDate: number;

  // Parsed headers
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  /** RFC 2822 Date header value. */
  date: string;
  /** RFC 2822 Message-ID header. */
  messageId: string;
  inReplyTo?: string;
  references?: string;

  // Body
  bodyPlain?: string;
  bodyHtml?: string;
  /** Gmail's snippet (~first 100 chars). */
  snippet: string;

  // Attachments (metadata only; files stored separately)
  attachments: AttachmentMeta[];

  sizeEstimate: number;
}

// ─── MIME walk result ───

export interface MimeWalkResult {
  plain: string;
  html: string;
  attachments: AttachmentMeta[];
}

// ─── Adapter configuration (resolved from env vars) ───

export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  maxAttachmentBytes: number;
  includeSpamTrash: boolean;
  includeDrafts: boolean;
  /** Messages to fetch per page (messages.list maxResults). */
  pageSize: number;
  /** Concurrent message fetch operations. */
  concurrency: number;
}

// ─── History change sets ───

export interface HistoryChanges {
  addedMessageIds: string[];
  deletedMessageIds: string[];
  labelChanges: LabelChange[];
  newHistoryId: string | null;
}

export interface LabelChange {
  messageId: string;
  addedLabelIds: string[];
  removedLabelIds: string[];
}
