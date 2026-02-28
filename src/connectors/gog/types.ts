/** Types for the GOG (Gmail via gog CLI) adapter. */

export interface GogLabel {
  id: string;
  name: string;
  type: string;
  labelListVisibility?: string;
  messageListVisibility?: string;
}

export interface GogMessageSummary {
  id: string;
  threadId: string;
  date: string;
  from: string;
  subject: string;
  labels: string[];
}

export interface GogMessageFull {
  body: string;
  headers: {
    from: string;
    to: string;
    cc: string;
    bcc: string;
    date: string;
    subject: string;
  };
  message: {
    id: string;
    threadId: string;
    historyId: string;
    internalDate: string;
    labelIds: string[];
    payload: {
      body: Record<string, unknown>;
      headers: Array<{ name: string; value: string }>;
      mimeType: string;
      parts?: GogMimePart[];
    };
    sizeEstimate: number;
    snippet: string;
  };
}

export interface GogMimePart {
  mimeType: string;
  filename?: string;
  body: {
    size: number;
    attachmentId?: string;
    data?: string;
  };
  headers?: Array<{ name: string; value: string }>;
  parts?: GogMimePart[];
}

export interface GogHistoryRecord {
  messagesAdded?: Array<{ id: string; threadId: string; labelIds: string[] }>;
  messagesDeleted?: Array<{ id: string; threadId: string; labelIds: string[] }>;
  labelsAdded?: Array<{ id: string; labelIds: string[] }>;
  labelsRemoved?: Array<{ id: string; labelIds: string[] }>;
}

export interface GogSyncMetadata {
  historyId: string | null;
  emailAddress: string;
  totalMessages: number;
  totalMessagesFetched: number;
  lastFullSyncAt: string | null;
  /** Message IDs fetched so far (for full sync resumability). */
  fetchedMessageIds: string[];
}
