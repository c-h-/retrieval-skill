// Adapter
export { GogAdapter } from "./adapter.js";
// CLI wrapper (for advanced usage / testing)
export { GogCli } from "./cli.js";
// Types
export type {
  GogLabel,
  GogMessageFull,
  GogMessageSummary,
  GogMimePart,
  GogSyncMetadata,
} from "./types.js";

// Writer utilities
export {
  removeMessage,
  writeLabels,
  writeMessage,
  writeThreadView,
} from "./writer.js";
