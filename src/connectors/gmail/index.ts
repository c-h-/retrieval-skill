// Adapter
export { GmailAdapter } from "./adapter.js";
// Client (for advanced usage / testing)
export { GmailClient } from "./client.js";
// MIME utilities
export { bodyToMarkdown, getHeader, parseMessage, walkParts } from "./mime.js";
// Types
export type {
  AttachmentMeta,
  GmailConfig,
  GmailLabel,
  GmailMessage,
  HistoryChanges,
  LabelChange,
  MimeWalkResult,
} from "./types.js";

// Writer utilities
export {
  removeMessage,
  resolveLabels,
  writeAttachments,
  writeLabels,
  writeMessage,
  writeThreadView,
} from "./writer.js";
