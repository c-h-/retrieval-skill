/**
 * Notion adapter — main sync orchestration.
 *
 * Implements the Adapter interface from @saas-mirror/core.
 * Supports full and incremental sync modes with:
 * - Page and database discovery via search API
 * - Recursive block tree fetching
 * - Markdown rendering
 * - Expiring file URL downloads
 * - Incremental sync via last_edited_time comparison
 * - Deletion detection
 * - Per-page checkpointing
 */

import type {
  Adapter,
  Logger,
  OutputWriter,
  SyncContext,
  SyncError,
  SyncResult,
} from "../core/index.js";
import { createOutputWriter, slugify, uniqueSlug } from "../core/index.js";
import { NotionApi } from "./api.js";
import { extractPageTitle } from "./renderer.js";
import type {
  DatabaseMeta,
  DatabaseProperty,
  NotionComment,
  NotionSyncMetadata,
  NotionUserInfo,
  PageMeta,
  PageTreeNode,
} from "./types.js";
import { NotionWriter } from "./writer.js";

// ─── Constants ───

const ADAPTER_NAME = "notion";

// ─── Helpers ───

function emptyMetadata(): NotionSyncMetadata {
  return {
    knownPageIds: [],
    knownDatabaseIds: [],
    pageLastEdited: {},
    dbLastEdited: {},
    userCache: {},
  };
}

function getMetadata(ctx: SyncContext): NotionSyncMetadata {
  const raw = ctx.state.metadata as unknown;
  if (raw && typeof raw === "object" && "knownPageIds" in (raw as object)) {
    return raw as NotionSyncMetadata;
  }
  return emptyMetadata();
}

function setMetadata(ctx: SyncContext, meta: NotionSyncMetadata): void {
  ctx.state.metadata = meta as unknown as Record<string, unknown>;
}

/**
 * Extract parent info from a Notion API page/database object.
 */
function extractParent(parent: Record<string, unknown>): {
  parentId: string | null;
  parentType: "workspace" | "page_id" | "database_id" | "block_id";
} {
  const type = parent.type as string;
  switch (type) {
    case "workspace":
      return { parentId: null, parentType: "workspace" };
    case "page_id":
      return { parentId: parent.page_id as string, parentType: "page_id" };
    case "database_id":
      return {
        parentId: parent.database_id as string,
        parentType: "database_id",
      };
    case "block_id":
      return { parentId: parent.block_id as string, parentType: "block_id" };
    default:
      return { parentId: null, parentType: "workspace" };
  }
}

/**
 * Build icon structure from Notion API icon.
 */
function extractIcon(
  icon: Record<string, unknown> | null | undefined,
): PageMeta["icon"] | undefined {
  if (!icon) return undefined;
  const type = icon.type as string;
  if (type === "emoji") {
    return { type: "emoji", emoji: icon.emoji as string };
  }
  if (type === "external") {
    const ext = icon.external as { url: string } | undefined;
    return { type: "external", url: ext?.url };
  }
  if (type === "file") {
    const file = icon.file as { url: string } | undefined;
    return { type: "file", url: file?.url };
  }
  return undefined;
}

/**
 * Build cover structure from Notion API cover.
 */
function extractCover(
  cover: Record<string, unknown> | null | undefined,
): PageMeta["cover"] | undefined {
  if (!cover) return undefined;
  const type = cover.type as string;
  if (type === "external") {
    const ext = cover.external as { url: string } | undefined;
    return ext ? { type: "external", url: ext.url } : undefined;
  }
  if (type === "file") {
    const file = cover.file as { url: string } | undefined;
    return file ? { type: "file", url: file.url } : undefined;
  }
  return undefined;
}

// ─── Adapter ───

export class NotionAdapter implements Adapter {
  readonly name = ADAPTER_NAME;

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: SyncError[] = [];
    let itemsSynced = 0;
    let itemsFailed = 0;

    const token = process.env.NOTION_TOKEN;
    if (!token) {
      return {
        adapter: ADAPTER_NAME,
        mode: ctx.mode,
        itemsSynced: 0,
        itemsFailed: 0,
        errors: [
          {
            entity: "config",
            error: "NOTION_TOKEN environment variable is not set",
            retryable: false,
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    const api = new NotionApi({
      token,
      rateLimiter: ctx.rateLimiter,
      logger: ctx.logger,
      signal: ctx.signal,
    });

    const out = createOutputWriter(ctx.outputDir);
    const writer = new NotionWriter(out, api, ctx.logger);
    const meta = getMetadata(ctx);

    try {
      if (ctx.mode === "full") {
        const result = await this.fullSync(ctx, api, out, writer, meta, errors);
        itemsSynced = result.synced;
        itemsFailed = result.failed;
      } else {
        const result = await this.incrementalSync(
          ctx,
          api,
          out,
          writer,
          meta,
          errors,
        );
        itemsSynced = result.synced;
        itemsFailed = result.failed;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "Sync aborted") {
        errors.push({
          entity: "sync",
          error: `Unexpected error: ${msg}`,
          retryable: true,
        });
        ctx.logger.error(`Sync failed: ${msg}`);
      }
    }

    // Final state save
    setMetadata(ctx, meta);
    ctx.state.lastSyncAt = new Date().toISOString();
    await ctx.state.checkpoint();

    return {
      adapter: ADAPTER_NAME,
      mode: ctx.mode,
      itemsSynced,
      itemsFailed,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  // ─── Full Sync ───

  private async fullSync(
    ctx: SyncContext,
    api: NotionApi,
    out: OutputWriter,
    writer: NotionWriter,
    meta: NotionSyncMetadata,
    errors: SyncError[],
  ): Promise<{ synced: number; failed: number }> {
    const logger = ctx.logger;
    let synced = 0;
    let failed = 0;

    // Step 1: Discover all pages and databases
    logger.info("Starting full sync — discovering pages and databases");
    const { pages, databases } = await this.discover(api, logger);
    logger.info(`Discovered ${pages.size} pages, ${databases.size} databases`);

    // Step 2: Fetch users
    await this.fetchUsers(api, meta, logger);

    // Step 3: Build page tree (parent -> children mapping)
    const tree = this.buildPageTree(pages, databases);
    const slugMap = this.buildSlugMap(tree);

    // Step 4: Process each root page/database (workspace-level)
    const roots = tree.filter((node) => node.parentType === "workspace");
    const totalItems = pages.size + databases.size;
    let processedCount = 0;

    for (const root of roots) {
      if (ctx.signal.aborted) break;

      const result = await this.processTreeNode(
        root,
        ctx,
        api,
        out,
        writer,
        meta,
        slugMap,
        errors,
      );
      synced += result.synced;
      failed += result.failed;
      processedCount += result.synced + result.failed;
      logger.progress(processedCount, totalItems, "Syncing pages");
    }

    // Step 5: Process databases (that are workspace-level or not yet processed)
    for (const [_dbId, dbObj] of databases) {
      if (ctx.signal.aborted) break;
      const parent = extractParent(
        (dbObj as Record<string, unknown>).parent as Record<string, unknown>,
      );
      if (parent.parentType === "workspace") {
      }
      // Databases nested inside pages are handled during page processing
    }

    // Step 6: Update known IDs for deletion detection
    meta.knownPageIds = Array.from(pages.keys());
    meta.knownDatabaseIds = Array.from(databases.keys());

    // Step 7: Write users
    await writer.writeUsers(meta.userCache);

    // Checkpoint
    setMetadata(ctx, meta);
    await ctx.state.checkpoint();

    return { synced, failed };
  }

  // ─── Incremental Sync ───

  private async incrementalSync(
    ctx: SyncContext,
    api: NotionApi,
    out: OutputWriter,
    writer: NotionWriter,
    meta: NotionSyncMetadata,
    errors: SyncError[],
  ): Promise<{ synced: number; failed: number }> {
    const logger = ctx.logger;
    let synced = 0;
    let failed = 0;

    const lastSyncAt = ctx.state.lastSyncAt;
    if (!lastSyncAt) {
      logger.info("No previous sync found, falling back to full sync");
      return this.fullSync(ctx, api, out, writer, meta, errors);
    }

    logger.info(`Starting incremental sync (since ${lastSyncAt})`);

    // Step 1: Search by last_edited_time descending, stop when older than lastSyncAt
    const changedPages = new Map<string, Record<string, unknown>>();
    const changedDatabases = new Map<string, Record<string, unknown>>();
    const currentIds = new Set<string>();

    // We need to do a full scan for deletion detection
    // Search all items and collect IDs, but only process changed ones
    for await (const item of api.search()) {
      if (ctx.signal.aborted) break;
      const obj = item as Record<string, unknown>;
      const id = obj.id as string;
      const objType = obj.object as string;
      const lastEdited = obj.last_edited_time as string;

      currentIds.add(id);

      if (objType === "page") {
        const prevEdited = meta.pageLastEdited[id];
        if (!prevEdited || lastEdited > prevEdited) {
          changedPages.set(id, obj);
        }
      } else if (objType === "database") {
        const prevEdited = meta.dbLastEdited[id];
        if (!prevEdited || lastEdited > prevEdited) {
          changedDatabases.set(id, obj);
        }
      }
    }

    logger.info(
      `Found ${changedPages.size} changed pages, ${changedDatabases.size} changed databases`,
    );

    // Step 2: Process changed pages
    // Build a full discovery for slug calculation
    const { pages: allPages, databases: allDatabases } =
      await this.discoverFromSearchResults(
        changedPages,
        changedDatabases,
        meta,
      );
    const tree = this.buildPageTree(allPages, allDatabases);
    const slugMap = this.buildSlugMap(tree);

    for (const [pageId, pageObj] of changedPages) {
      if (ctx.signal.aborted) break;
      try {
        await this.syncSinglePage(
          pageId,
          pageObj,
          ctx,
          api,
          out,
          writer,
          meta,
          slugMap,
        );
        synced++;
        meta.pageLastEdited[pageId] = pageObj.last_edited_time as string;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          entity: `page:${pageId}`,
          error: msg,
          retryable: isRetryableError(err),
        });
        logger.error(`Failed to sync page ${pageId}: ${msg}`);
      }

      // Checkpoint periodically
      if ((synced + failed) % 10 === 0) {
        setMetadata(ctx, meta);
        await ctx.state.checkpoint();
      }
    }

    // Step 3: Process changed databases
    for (const [dbId, dbObj] of changedDatabases) {
      if (ctx.signal.aborted) break;
      try {
        await this.syncSingleDatabase(
          dbId,
          dbObj,
          ctx,
          api,
          out,
          writer,
          meta,
          slugMap,
        );
        synced++;
        meta.dbLastEdited[dbId] = dbObj.last_edited_time as string;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({
          entity: `database:${dbId}`,
          error: msg,
          retryable: isRetryableError(err),
        });
        logger.error(`Failed to sync database ${dbId}: ${msg}`);
      }
    }

    // Step 4: Deletion detection
    const deletedPageIds = meta.knownPageIds.filter(
      (id) => !currentIds.has(id),
    );
    const deletedDbIds = meta.knownDatabaseIds.filter(
      (id) => !currentIds.has(id),
    );

    if (deletedPageIds.length > 0 || deletedDbIds.length > 0) {
      logger.info(
        `Detected ${deletedPageIds.length} deleted pages, ${deletedDbIds.length} deleted databases`,
      );
    }

    for (const pageId of deletedPageIds) {
      const outputPath = slugMap.get(pageId);
      if (outputPath) {
        try {
          await writer.removePage(outputPath);
          logger.info(`Removed deleted page: ${pageId}`);
        } catch {
          // Best effort removal
        }
      }
      delete meta.pageLastEdited[pageId];
    }
    for (const dbId of deletedDbIds) {
      delete meta.dbLastEdited[dbId];
    }

    // Step 5: Update known IDs
    meta.knownPageIds = Array.from(currentIds).filter(
      (id) => !meta.knownDatabaseIds.includes(id) || changedPages.has(id),
    );
    // More accurate: keep all page IDs from current scan
    const knownPageSet = new Set(meta.knownPageIds);
    for (const id of currentIds) {
      if (!allDatabases.has(id)) {
        knownPageSet.add(id);
      }
    }
    meta.knownPageIds = Array.from(knownPageSet);
    meta.knownDatabaseIds = Array.from(
      new Set([
        ...meta.knownDatabaseIds.filter((id) => currentIds.has(id)),
        ...changedDatabases.keys(),
      ]),
    );

    // Step 6: Write users
    await this.fetchUsers(api, meta, logger);
    await writer.writeUsers(meta.userCache);

    return { synced, failed };
  }

  // ─── Discovery ───

  private async discover(
    api: NotionApi,
    _logger: Logger,
  ): Promise<{
    pages: Map<string, Record<string, unknown>>;
    databases: Map<string, Record<string, unknown>>;
  }> {
    const pages = new Map<string, Record<string, unknown>>();
    const databases = new Map<string, Record<string, unknown>>();

    for await (const item of api.search()) {
      const obj = item as Record<string, unknown>;
      const id = obj.id as string;
      if (obj.object === "page") {
        pages.set(id, obj);
      } else if (obj.object === "database") {
        databases.set(id, obj);
      }
    }

    return { pages, databases };
  }

  /**
   * Build a combined discovery map from changed items + existing state.
   * This is needed during incremental sync to compute slugs correctly.
   */
  private async discoverFromSearchResults(
    changedPages: Map<string, Record<string, unknown>>,
    changedDatabases: Map<string, Record<string, unknown>>,
    _meta: NotionSyncMetadata,
  ): Promise<{
    pages: Map<string, Record<string, unknown>>;
    databases: Map<string, Record<string, unknown>>;
  }> {
    // For incremental, we use changed pages directly.
    // For slug computation of existing pages, we use stored metadata.
    // This is an approximation — slug stability is maintained by using uniqueSlug with IDs.
    return { pages: changedPages, databases: changedDatabases };
  }

  // ─── Page Tree Building ───

  private buildPageTree(
    pages: Map<string, Record<string, unknown>>,
    databases: Map<string, Record<string, unknown>>,
  ): PageTreeNode[] {
    const nodes = new Map<string, PageTreeNode>();
    const slugTracker = new Map<string, Set<string>>();

    // Create nodes for pages
    for (const [id, obj] of pages) {
      const props = obj.properties as Record<string, unknown> | undefined;
      const title = props ? extractPageTitle(props) : "Untitled";
      const parent = extractParent(obj.parent as Record<string, unknown>);
      const slug = this.generateSlug(title, id, slugTracker);

      nodes.set(id, {
        id,
        title,
        slug,
        parentId: parent.parentId,
        parentType: parent.parentType,
        objectType: "page",
        lastEditedTime: obj.last_edited_time as string,
        archived: (obj.archived as boolean) ?? false,
        children: [],
        outputPath: slug,
      });
    }

    // Create nodes for databases
    for (const [id, obj] of databases) {
      const titleArr = (obj.title as Array<{ plain_text: string }>) ?? [];
      const title =
        titleArr.map((t) => t.plain_text).join("") || "Untitled Database";
      const parent = extractParent(obj.parent as Record<string, unknown>);
      const slug = this.generateSlug(title, id, slugTracker);

      nodes.set(id, {
        id,
        title,
        slug,
        parentId: parent.parentId,
        parentType: parent.parentType,
        objectType: "database",
        lastEditedTime: obj.last_edited_time as string,
        archived: (obj.archived as boolean) ?? false,
        children: [],
        outputPath: slug,
      });
    }

    // Wire parent-child relationships and compute output paths
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) {
        const parentNode = nodes.get(node.parentId)!;
        parentNode.children.push(node);
        node.outputPath = `${parentNode.outputPath}/${node.slug}`;
      }
    }

    // Return all nodes (flat list — roots can be filtered by parentType)
    return Array.from(nodes.values());
  }

  private generateSlug(
    title: string,
    id: string,
    tracker: Map<string, Set<string>>,
  ): string {
    const baseSlug = slugify(title);
    const existing = tracker.get(baseSlug);
    if (!existing) {
      tracker.set(baseSlug, new Set([id]));
      return uniqueSlug(title, id);
    }
    existing.add(id);
    return uniqueSlug(title, id);
  }

  private buildSlugMap(tree: PageTreeNode[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const node of tree) {
      map.set(node.id, node.outputPath);
    }
    return map;
  }

  // ─── Process a tree node (page or database) recursively ───

  private async processTreeNode(
    node: PageTreeNode,
    ctx: SyncContext,
    api: NotionApi,
    out: OutputWriter,
    writer: NotionWriter,
    meta: NotionSyncMetadata,
    slugMap: Map<string, string>,
    errors: SyncError[],
  ): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;

    if (ctx.signal.aborted) return { synced, failed };

    try {
      if (node.objectType === "page") {
        // Find the original API object for this page
        await this.syncSinglePageFromNode(
          node,
          ctx,
          api,
          out,
          writer,
          meta,
          slugMap,
        );
        meta.pageLastEdited[node.id] = node.lastEditedTime;
        synced++;
      } else if (node.objectType === "database") {
        await this.syncSingleDatabaseFromNode(
          node,
          ctx,
          api,
          out,
          writer,
          meta,
          slugMap,
        );
        meta.dbLastEdited[node.id] = node.lastEditedTime;
        synced++;
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({
        entity: `${node.objectType}:${node.id}`,
        error: msg,
        retryable: isRetryableError(err),
      });
      ctx.logger.error(
        `Failed to sync ${node.objectType} "${node.title}" (${node.id}): ${msg}`,
      );
    }

    // Process children
    for (const child of node.children) {
      if (ctx.signal.aborted) break;
      const result = await this.processTreeNode(
        child,
        ctx,
        api,
        out,
        writer,
        meta,
        slugMap,
        errors,
      );
      synced += result.synced;
      failed += result.failed;
    }

    // Checkpoint after each top-level page tree
    if (node.parentType === "workspace") {
      setMetadata(ctx, meta);
      await ctx.state.checkpoint();
    }

    return { synced, failed };
  }

  // ─── Sync a single page ───

  private async syncSinglePageFromNode(
    node: PageTreeNode,
    ctx: SyncContext,
    api: NotionApi,
    _out: OutputWriter,
    writer: NotionWriter,
    _meta: NotionSyncMetadata,
    slugMap: Map<string, string>,
  ): Promise<void> {
    const logger = ctx.logger;
    logger.info(`Syncing page: "${node.title}" (${node.id})`);

    // Fetch page metadata
    const pageObj = await api.getPage(node.id);
    const pageMeta = this.buildPageMeta(pageObj as Record<string, unknown>);

    // Fetch block tree
    const blocks = await api.fetchBlockTree(node.id);

    // Build child slug maps for link resolution
    const childPageSlugs = new Map<string, string>();
    const childDbSlugs = new Map<string, string>();
    for (const block of blocks) {
      if (block.type === "child_page") {
        const childSlug = slugMap.get(block.id);
        if (childSlug) {
          childPageSlugs.set(block.id, childSlug.split("/").pop() ?? childSlug);
        }
      }
      if (block.type === "child_database") {
        const childSlug = slugMap.get(block.id);
        if (childSlug) {
          childDbSlugs.set(block.id, childSlug.split("/").pop() ?? childSlug);
        }
      }
    }

    // Fetch comments
    const comments = await this.fetchComments(api, node.id, logger);

    // Write to output
    await writer.writePage({
      outputPath: node.outputPath,
      meta: pageMeta,
      blocks,
      comments,
      childPageSlugs,
      childDbSlugs,
    });
  }

  private async syncSinglePage(
    pageId: string,
    pageObj: Record<string, unknown>,
    ctx: SyncContext,
    api: NotionApi,
    _out: OutputWriter,
    writer: NotionWriter,
    _meta: NotionSyncMetadata,
    slugMap: Map<string, string>,
  ): Promise<void> {
    const logger = ctx.logger;
    const pageMeta = this.buildPageMeta(pageObj);
    logger.info(`Syncing page: "${pageMeta.title}" (${pageId})`);

    const outputPath = slugMap.get(pageId);
    if (!outputPath) {
      // Generate a path for this page
      const slug = uniqueSlug(pageMeta.title, pageId);
      const parent = extractParent(pageObj.parent as Record<string, unknown>);
      const parentPath = parent.parentId
        ? slugMap.get(parent.parentId)
        : undefined;
      const fullPath = parentPath ? `${parentPath}/${slug}` : slug;
      slugMap.set(pageId, fullPath);
    }

    const finalPath = slugMap.get(pageId)!;

    // Fetch block tree
    const blocks = await api.fetchBlockTree(pageId);

    // Build child slug maps
    const childPageSlugs = new Map<string, string>();
    const childDbSlugs = new Map<string, string>();
    for (const block of blocks) {
      if (block.type === "child_page") {
        const childSlug = slugMap.get(block.id);
        if (childSlug) {
          childPageSlugs.set(block.id, childSlug.split("/").pop() ?? childSlug);
        }
      }
      if (block.type === "child_database") {
        const childSlug = slugMap.get(block.id);
        if (childSlug) {
          childDbSlugs.set(block.id, childSlug.split("/").pop() ?? childSlug);
        }
      }
    }

    // Fetch comments
    const comments = await this.fetchComments(api, pageId, logger);

    await writer.writePage({
      outputPath: finalPath,
      meta: pageMeta,
      blocks,
      comments,
      childPageSlugs,
      childDbSlugs,
    });
  }

  // ─── Sync a single database ───

  private async syncSingleDatabaseFromNode(
    node: PageTreeNode,
    ctx: SyncContext,
    api: NotionApi,
    _out: OutputWriter,
    writer: NotionWriter,
    meta: NotionSyncMetadata,
    _slugMap: Map<string, string>,
  ): Promise<void> {
    const logger = ctx.logger;
    logger.info(`Syncing database: "${node.title}" (${node.id})`);

    // Fetch database schema
    const dbObj = await api.getDatabase(node.id);
    const dbMeta = this.buildDatabaseMeta(dbObj as Record<string, unknown>);

    // Write schema
    await writer.writeDatabaseSchema(node.outputPath, dbMeta);

    // Query all rows
    let rowCount = 0;
    const rowSlugTracker = new Map<string, Set<string>>();

    for await (const row of api.queryDatabase(node.id)) {
      if (ctx.signal.aborted) break;

      const rowObj = row as Record<string, unknown>;
      const rowId = rowObj.id as string;
      const rowProps = rowObj.properties as Record<string, unknown> | undefined;
      const rowTitle = rowProps ? extractPageTitle(rowProps) : "Untitled";
      const rowSlug = this.generateSlug(rowTitle, rowId, rowSlugTracker);

      const rowMeta = this.buildPageMeta(rowObj);

      // Fetch row blocks
      try {
        const blocks = await api.fetchBlockTree(rowId);

        const rowPath = `${node.outputPath}/rows/${rowSlug}.md`;
        await writer.writeDatabaseRow({
          outputPath: rowPath,
          meta: rowMeta,
          blocks,
          childPageSlugs: new Map(),
          childDbSlugs: new Map(),
        });

        rowCount++;
        meta.pageLastEdited[rowId] = rowObj.last_edited_time as string;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to sync database row ${rowId}: ${msg}`);
      }
    }

    logger.info(`Synced ${rowCount} rows for database "${node.title}"`);
  }

  private async syncSingleDatabase(
    dbId: string,
    dbObj: Record<string, unknown>,
    ctx: SyncContext,
    api: NotionApi,
    _out: OutputWriter,
    writer: NotionWriter,
    meta: NotionSyncMetadata,
    slugMap: Map<string, string>,
  ): Promise<void> {
    const logger = ctx.logger;
    const titleArr = (dbObj.title as Array<{ plain_text: string }>) ?? [];
    const title =
      titleArr.map((t) => t.plain_text).join("") || "Untitled Database";
    logger.info(`Syncing database: "${title}" (${dbId})`);

    // Determine output path
    let outputPath = slugMap.get(dbId);
    if (!outputPath) {
      const slug = uniqueSlug(title, dbId);
      const parent = extractParent(dbObj.parent as Record<string, unknown>);
      const parentPath = parent.parentId
        ? slugMap.get(parent.parentId)
        : undefined;
      outputPath = parentPath ? `${parentPath}/${slug}` : slug;
      slugMap.set(dbId, outputPath);
    }

    // Fetch full schema
    const fullDb = await api.getDatabase(dbId);
    const dbMeta = this.buildDatabaseMeta(fullDb as Record<string, unknown>);
    await writer.writeDatabaseSchema(outputPath, dbMeta);

    // Query rows
    let rowCount = 0;
    const rowSlugTracker = new Map<string, Set<string>>();

    for await (const row of api.queryDatabase(dbId)) {
      if (ctx.signal.aborted) break;

      const rowObj = row as Record<string, unknown>;
      const rowId = rowObj.id as string;
      const rowProps = rowObj.properties as Record<string, unknown> | undefined;
      const rowTitle = rowProps ? extractPageTitle(rowProps) : "Untitled";
      const rowSlug = this.generateSlug(rowTitle, rowId, rowSlugTracker);

      const rowMeta = this.buildPageMeta(rowObj);

      try {
        const blocks = await api.fetchBlockTree(rowId);
        const rowPath = `${outputPath}/rows/${rowSlug}.md`;
        await writer.writeDatabaseRow({
          outputPath: rowPath,
          meta: rowMeta,
          blocks,
          childPageSlugs: new Map(),
          childDbSlugs: new Map(),
        });
        rowCount++;
        meta.pageLastEdited[rowId] = rowObj.last_edited_time as string;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Failed to sync database row ${rowId}: ${msg}`);
      }
    }

    logger.info(`Synced ${rowCount} rows for database "${title}"`);
  }

  // ─── Users ───

  private async fetchUsers(
    api: NotionApi,
    meta: NotionSyncMetadata,
    logger: Logger,
  ): Promise<void> {
    try {
      for await (const user of api.listUsers()) {
        const u = user as Record<string, unknown>;
        const id = u.id as string;
        const type = u.type as "person" | "bot";
        const name = (u.name as string) ?? "Unknown";
        const person = u.person as { email?: string } | undefined;
        const info: NotionUserInfo = {
          name,
          type,
          email: person?.email,
          avatarUrl: u.avatar_url as string | undefined,
        };
        meta.userCache[id] = info;
      }
      logger.info(`Cached ${Object.keys(meta.userCache).length} users`);
    } catch (err) {
      // Users endpoint may not be available with all integration permissions
      logger.warn(
        `Could not fetch users: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Comments ───

  private async fetchComments(
    api: NotionApi,
    pageId: string,
    logger: Logger,
  ): Promise<NotionComment[]> {
    const comments: NotionComment[] = [];
    try {
      for await (const comment of api.listComments(pageId)) {
        const c = comment as Record<string, unknown>;
        const richText = (c.rich_text as Array<Record<string, unknown>>) ?? [];
        comments.push({
          id: c.id as string,
          createdTime: c.created_time as string,
          createdBy:
            ((c.created_by as Record<string, unknown>)?.id as string) ?? "",
          richText: richText.map((rt) => ({
            type: (rt.type as "text" | "mention" | "equation") ?? "text",
            plain_text: (rt.plain_text as string) ?? "",
            href: (rt.href as string | null) ?? null,
            annotations:
              (rt.annotations as NotionComment["richText"][number]["annotations"]) ?? {
                bold: false,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: "default",
              },
          })),
          parentType:
            ((c.parent as Record<string, unknown>)?.type as
              | "page_id"
              | "block_id") ?? "page_id",
          parentId: pageId,
        });
      }
    } catch (err) {
      // Comments endpoint may fail for some pages; non-critical
      logger.warn(
        `Could not fetch comments for ${pageId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return comments;
  }

  // ─── Build metadata from API objects ───

  private buildPageMeta(obj: Record<string, unknown>): PageMeta {
    const props = obj.properties as Record<string, unknown> | undefined;
    const title = props ? extractPageTitle(props) : "Untitled";
    const parent = extractParent(obj.parent as Record<string, unknown>);

    return {
      id: obj.id as string,
      title,
      url: (obj.url as string) ?? "",
      parentId: parent.parentId,
      parentType: parent.parentType,
      createdTime: (obj.created_time as string) ?? "",
      lastEditedTime: (obj.last_edited_time as string) ?? "",
      createdBy:
        ((obj.created_by as Record<string, unknown>)?.id as string) ?? "",
      lastEditedBy:
        ((obj.last_edited_by as Record<string, unknown>)?.id as string) ?? "",
      archived: (obj.archived as boolean) ?? false,
      icon: extractIcon(obj.icon as Record<string, unknown> | null),
      cover: extractCover(obj.cover as Record<string, unknown> | null),
      properties: props,
    };
  }

  private buildDatabaseMeta(obj: Record<string, unknown>): DatabaseMeta {
    const titleArr = (obj.title as Array<{ plain_text: string }>) ?? [];
    const title =
      titleArr.map((t) => t.plain_text).join("") || "Untitled Database";
    const parent = extractParent(obj.parent as Record<string, unknown>);
    const rawProps =
      (obj.properties as Record<string, Record<string, unknown>>) ?? {};

    const properties: Record<string, DatabaseProperty> = {};
    for (const [name, prop] of Object.entries(rawProps)) {
      const type = prop.type as string;
      // The config is everything in the property except id, type, and name
      const { id: propId, type: _t, name: _n, ...config } = prop;
      properties[name] = {
        id: propId as string,
        name,
        type,
        config: config[type] ?? null,
      };
    }

    return {
      id: obj.id as string,
      title,
      url: (obj.url as string) ?? "",
      parentId: parent.parentId,
      parentType: parent.parentType as "workspace" | "page_id" | "block_id",
      createdTime: (obj.created_time as string) ?? "",
      lastEditedTime: (obj.last_edited_time as string) ?? "",
      archived: (obj.archived as boolean) ?? false,
      icon: extractIcon(obj.icon as Record<string, unknown> | null),
      cover: extractCover(obj.cover as Record<string, unknown> | null),
      properties,
    };
  }
}

// ─── Error Classification ───

function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("rate") ||
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("503") ||
      msg.includes("502") ||
      msg.includes("429")
    ) {
      return true;
    }
  }
  return false;
}
