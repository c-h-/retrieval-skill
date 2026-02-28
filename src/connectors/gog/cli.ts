/**
 * Wrapper around the `gog` CLI binary (https://github.com/steipete/gogcli).
 *
 * All interactions with Gmail go through `gog` which handles OAuth
 * via its own keyring — no raw credentials needed.
 */

import { execFile } from "node:child_process";
import type { Logger } from "../core/index.js";
import type { GogLabel, GogMessageFull, GogMessageSummary } from "./types.js";

const DEFAULT_GOG_PATH = "gog";

export class GogCli {
  private readonly gogPath: string;
  private readonly account: string;

  constructor(account: string, _logger: Logger, gogPath?: string) {
    this.gogPath = gogPath ?? process.env.GOG_PATH ?? DEFAULT_GOG_PATH;
    this.account = account;
  }

  // ─── Labels ───

  async listLabels(): Promise<GogLabel[]> {
    const result = await this.exec(["gmail", "labels", "list"]);
    const parsed = JSON.parse(result);
    return parsed.labels ?? [];
  }

  // ─── Message Search (list IDs) ───

  async searchMessages(
    query: string,
    maxResults: number,
    pageToken?: string,
  ): Promise<{ messages: GogMessageSummary[]; nextPageToken?: string }> {
    const args = [
      "gmail",
      "messages",
      "search",
      query,
      "--max",
      String(maxResults),
    ];
    if (pageToken) args.push("--page", pageToken);

    const result = await this.exec(args);
    const parsed = JSON.parse(result);
    return {
      messages: parsed.messages ?? [],
      nextPageToken: parsed.nextPageToken ?? undefined,
    };
  }

  // ─── Get Full Message ───

  async getMessage(messageId: string): Promise<GogMessageFull> {
    const result = await this.exec([
      "gmail",
      "get",
      messageId,
      "--format",
      "full",
    ]);
    return JSON.parse(result);
  }

  // ─── Attachment Download ───

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<Buffer> {
    const result = await this.execRaw([
      "gmail",
      "attachment",
      messageId,
      attachmentId,
    ]);
    return result;
  }

  // ─── History ───

  async getHistory(
    sinceHistoryId: string,
    maxResults = 100,
    pageToken?: string,
  ): Promise<{
    history: Array<Record<string, unknown>>;
    historyId: string;
    nextPageToken?: string;
  }> {
    const args = [
      "gmail",
      "history",
      "--since",
      sinceHistoryId,
      "--max",
      String(maxResults),
    ];
    if (pageToken) args.push("--page", pageToken);

    const result = await this.exec(args);
    return JSON.parse(result);
  }

  // ─── Internal Execution ───

  private exec(subArgs: string[]): Promise<string> {
    const args = [
      ...subArgs,
      "--json",
      "--no-input",
      "--account",
      this.account,
    ];
    return new Promise((resolve, reject) => {
      execFile(
        this.gogPath,
        args,
        { maxBuffer: 50 * 1024 * 1024, timeout: 60_000 },
        (err, stdout, stderr) => {
          if (err) {
            const msg = stderr?.trim() || err.message;
            reject(
              new Error(`gog ${subArgs.slice(0, 3).join(" ")} failed: ${msg}`),
            );
            return;
          }
          resolve(stdout);
        },
      );
    });
  }

  private execRaw(subArgs: string[]): Promise<Buffer> {
    const args = [...subArgs, "--no-input", "--account", this.account];
    return new Promise((resolve, reject) => {
      execFile(
        this.gogPath,
        args,
        { maxBuffer: 50 * 1024 * 1024, timeout: 60_000, encoding: "buffer" },
        (err, stdout, stderr) => {
          if (err) {
            const msg = stderr?.toString().trim() || err.message;
            reject(
              new Error(`gog ${subArgs.slice(0, 3).join(" ")} failed: ${msg}`),
            );
            return;
          }
          resolve(stdout as unknown as Buffer);
        },
      );
    });
  }
}
