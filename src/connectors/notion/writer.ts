/**
 * Notion adapter — output writer.
 *
 * Handles writing pages, databases, assets, and metadata to the output
 * directory. Manages Notion-hosted file downloads (expiring S3 URLs)
 * and path resolution.
 */

import * as path from "node:path";
import type { Logger, OutputWriter } from "../core/index.js";
import type { NotionApi } from "./api.js";
import {
  type RenderContext,
  renderBlocks,
  renderPropertyValue,
} from "./renderer.js";
import type {
  BlockTree,
  DatabaseMeta,
  NotionComment,
  NotionUserInfo,
  PageMeta,
} from "./types.js";

// ─── File URL Helpers ───

/**
 * Extract a file extension from a URL or block type hint.
 */
function extensionFromUrl(url: string, hint: string): string {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    if (ext && ext.length <= 6) return ext;
  } catch {
    // Invalid URL
  }
  // Fallback based on hint
  switch (hint) {
    case "image":
      return ".png";
    case "pdf":
      return ".pdf";
    case "audio":
      return ".mp3";
    case "video":
      return ".mp4";
    default:
      return ".bin";
  }
}

/**
 * Generate a deterministic asset filename from a block ID and hint.
 */
function assetFilename(blockId: string, url: string, hint: string): string {
  const cleanId = blockId.replace(/-/g, "").slice(0, 12);
  const ext = extensionFromUrl(url, hint);
  return `${cleanId}${ext}`;
}

// ─── Notion Output Writer ───

export class NotionWriter {
  private readonly out: OutputWriter;
  private readonly api: NotionApi;
  private readonly logger: Logger;

  constructor(out: OutputWriter, api: NotionApi, logger: Logger) {
    this.out = out;
    this.api = api;
    this.logger = logger;
  }

  // ─── Write a page ───

  async writePage(opts: {
    outputPath: string;
    meta: PageMeta;
    blocks: BlockTree[];
    comments: NotionComment[];
    childPageSlugs: Map<string, string>;
    childDbSlugs: Map<string, string>;
  }): Promise<void> {
    const { outputPath, meta, blocks, comments, childPageSlugs, childDbSlugs } =
      opts;
    const assetsDir = path.posix.join(outputPath, "assets");

    // File URL resolver: downloads Notion-hosted files and returns local path
    const resolveFileUrl = async (
      url: string,
      blockId: string,
      hint: string,
    ): Promise<string> => {
      const filename = assetFilename(blockId, url, hint);
      const assetPath = path.posix.join(assetsDir, filename);
      try {
        const buffer = await this.api.downloadFile(url);
        await this.out.writeBinary(assetPath, buffer);
        // Return path relative to the page directory
        return `./assets/${filename}`;
      } catch (err) {
        this.logger.warn(
          `Failed to download asset ${filename}: ${String(err)}`,
        );
        return url; // Fall back to original URL
      }
    };

    // Render blocks to Markdown
    const renderCtx: Partial<RenderContext> = {
      resolveFileUrl,
      childPageSlugs,
      childDbSlugs,
    };
    const markdown = await renderBlocks(blocks, renderCtx);

    // Write index.md
    const docPath = path.posix.join(outputPath, "index.md");
    const frontmatter: Record<string, unknown> = {
      id: meta.id,
      title: meta.title,
      url: meta.url,
      created_time: meta.createdTime,
      last_edited_time: meta.lastEditedTime,
    };
    if (meta.archived) frontmatter.archived = true;
    if (meta.icon?.emoji) frontmatter.icon = meta.icon.emoji;

    await this.out.writeDocument(docPath, frontmatter, markdown);

    // Write _meta.json
    const metaPath = path.posix.join(outputPath, "_meta.json");
    const metaData: Record<string, unknown> = {
      id: meta.id,
      title: meta.title,
      url: meta.url,
      createdTime: meta.createdTime,
      lastEditedTime: meta.lastEditedTime,
      parentId: meta.parentId,
      parentType: meta.parentType,
      archived: meta.archived,
      createdBy: meta.createdBy,
      lastEditedBy: meta.lastEditedBy,
    };
    if (meta.icon) metaData.icon = meta.icon;
    if (meta.cover) metaData.cover = meta.cover;
    if (comments.length > 0) {
      metaData.comments = comments.map((c) => ({
        id: c.id,
        createdTime: c.createdTime,
        createdBy: c.createdBy,
        text: c.richText.map((rt) => rt.plain_text).join(""),
      }));
    }

    await this.out.writeMeta(metaPath, metaData);
  }

  // ─── Write a database row ───

  async writeDatabaseRow(opts: {
    outputPath: string;
    meta: PageMeta;
    blocks: BlockTree[];
    childPageSlugs: Map<string, string>;
    childDbSlugs: Map<string, string>;
  }): Promise<void> {
    const { outputPath, meta, blocks, childPageSlugs, childDbSlugs } = opts;
    const assetsDir = path.posix.join(path.posix.dirname(outputPath), "assets");

    // Resolve file URLs
    const resolveFileUrl = async (
      url: string,
      blockId: string,
      hint: string,
    ): Promise<string> => {
      const filename = assetFilename(blockId, url, hint);
      const assetPath = path.posix.join(assetsDir, filename);
      try {
        const buffer = await this.api.downloadFile(url);
        await this.out.writeBinary(assetPath, buffer);
        return `./assets/${filename}`;
      } catch (err) {
        this.logger.warn(
          `Failed to download asset ${filename}: ${String(err)}`,
        );
        return url;
      }
    };

    const renderCtx: Partial<RenderContext> = {
      resolveFileUrl,
      childPageSlugs,
      childDbSlugs,
    };
    const markdown = await renderBlocks(blocks, renderCtx);

    // Build frontmatter from properties
    const frontmatter: Record<string, unknown> = {
      id: meta.id,
      url: meta.url,
    };
    if (meta.properties) {
      for (const [key, value] of Object.entries(meta.properties)) {
        const prop = value as Record<string, unknown>;
        if (prop.type === "title") continue; // Title is in the heading
        const rendered = renderPropertyValue(prop);
        if (rendered !== null && rendered !== undefined) {
          frontmatter[key] = rendered;
        }
      }
    }

    await this.out.writeDocument(
      outputPath,
      frontmatter,
      `# ${meta.title}\n\n${markdown}`,
    );

    // Write row _meta.json
    const metaPath = outputPath.replace(/\.md$/, "._meta.json");
    await this.out.writeMeta(metaPath, {
      id: meta.id,
      title: meta.title,
      url: meta.url,
      createdTime: meta.createdTime,
      lastEditedTime: meta.lastEditedTime,
      archived: meta.archived,
    });
  }

  // ─── Write database schema ───

  async writeDatabaseSchema(
    outputPath: string,
    meta: DatabaseMeta,
  ): Promise<void> {
    const schemaPath = path.posix.join(outputPath, "_db_schema.json");
    const schemaData: Record<string, unknown> = {
      id: meta.id,
      title: meta.title,
      url: meta.url,
      createdTime: meta.createdTime,
      lastEditedTime: meta.lastEditedTime,
      archived: meta.archived,
      properties: Object.fromEntries(
        Object.entries(meta.properties).map(([name, prop]) => [
          name,
          { id: prop.id, type: prop.type, config: prop.config },
        ]),
      ),
    };
    if (meta.icon) schemaData.icon = meta.icon;
    if (meta.cover) schemaData.cover = meta.cover;

    await this.out.writeMeta(schemaPath, schemaData);
  }

  // ─── Write users cache ───

  async writeUsers(userCache: Record<string, NotionUserInfo>): Promise<void> {
    await this.out.writeMeta("_users.json", userCache);
  }

  // ─── Remove a page/database directory ───

  async removePage(outputPath: string): Promise<void> {
    // Remove index.md and _meta.json
    await this.out.remove(path.posix.join(outputPath, "index.md"));
    await this.out.remove(path.posix.join(outputPath, "_meta.json"));
  }
}
