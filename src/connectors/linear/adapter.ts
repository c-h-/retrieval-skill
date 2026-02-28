/**
 * Linear adapter — syncs teams, users, labels, workflow states, cycles,
 * projects, issues (with comments, relations, attachments) from the Linear API.
 *
 * Supports both full hydration and incremental sync modes.
 */

import type {
  Adapter,
  Logger,
  OutputWriter,
  SyncContext,
  SyncError,
  SyncResult,
} from "../core/index.js";
import { createOutputWriter, slugify } from "../core/index.js";
import { LinearGraphQLClient } from "./graphql.js";
import {
  CYCLES_QUERY,
  ISSUE_COMMENTS_QUERY,
  LABELS_QUERY,
  PROJECTS_QUERY,
  TEAM_ISSUES_INCREMENTAL_QUERY,
  TEAM_ISSUES_QUERY,
  TEAMS_QUERY,
  USERS_QUERY,
  VIEWER_QUERY,
  WORKFLOW_STATES_QUERY,
} from "./queries.js";
import type {
  AttachmentRecord,
  CommentRecord,
  CycleRecord,
  IssueCommentsResponse,
  IssueNode,
  IssueRecord,
  IssueRelation,
  LabelRecord,
  LabelsResponse,
  LinearConfig,
  LookupMaps,
  ProjectRecord,
  ProjectsResponse,
  TeamCyclesResponse,
  TeamIssuesResponse,
  TeamRecord,
  TeamStatesResponse,
  TeamsResponse,
  UserRecord,
  UsersResponse,
  ViewerResponse,
  WorkflowStateRecord,
} from "./types.js";
import { INVERSE_RELATION_TYPES } from "./types.js";
import { LinearWriter } from "./writer.js";

export class LinearAdapter implements Adapter {
  readonly name = "linear";
  private readonly config: LinearConfig;

  constructor(config?: Partial<LinearConfig>) {
    const apiKey = config?.apiKey ?? process.env.LINEAR_API_KEY;
    if (!apiKey) {
      throw new Error(
        "LINEAR_API_KEY environment variable or apiKey config is required",
      );
    }

    this.config = {
      apiKey,
      teamKeys:
        config?.teamKeys ?? parseCommaSeparated(process.env.LINEAR_TEAM_KEYS),
      includeArchived:
        config?.includeArchived ??
        parseBoolEnv(process.env.LINEAR_INCLUDE_ARCHIVED, true),
      downloadAttachments:
        config?.downloadAttachments ??
        parseBoolEnv(process.env.LINEAR_DOWNLOAD_ATTACHMENTS, true),
    };
  }

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: SyncError[] = [];
    let itemsSynced = 0;
    let itemsFailed = 0;

    const gql = new LinearGraphQLClient({
      apiKey: this.config.apiKey,
      rateLimiter: ctx.rateLimiter,
      logger: ctx.logger,
      signal: ctx.signal,
    });

    const outputWriter = createOutputWriter(ctx.outputDir);
    const writer = new LinearWriter(outputWriter, ctx.logger);

    try {
      // 1. Validate auth
      ctx.logger.info("Validating Linear API key...");
      const viewer = await gql.request<ViewerResponse>(VIEWER_QUERY);
      ctx.logger.info(
        `Authenticated as ${viewer.viewer.name} (${viewer.viewer.email})`,
      );

      // 2. Fetch metadata (always full refresh for meta entities)
      ctx.logger.info("Fetching organization metadata...");
      const lookups = await this.fetchMetadata(gql, writer, ctx.logger);

      // 3. Filter teams if configured
      const teams = this.filterTeams(lookups, ctx.logger);

      // 4. Fetch and write projects
      ctx.logger.info("Fetching projects...");
      const projectResult = await this.syncProjects(
        gql,
        writer,
        lookups,
        ctx.logger,
      );
      itemsSynced += projectResult.synced;
      itemsFailed += projectResult.failed;
      errors.push(...projectResult.errors);

      // 5. Fetch and write issues per team
      const isIncremental =
        ctx.mode === "incremental" && ctx.state.lastSyncAt != null;
      const since = isIncremental ? ctx.state.lastSyncAt! : undefined;

      if (isIncremental) {
        ctx.logger.info(
          `Incremental sync: fetching issues updated since ${since}`,
        );
      } else {
        ctx.logger.info("Full sync: fetching all issues");
      }

      for (const team of teams) {
        ctx.logger.info(
          `Syncing issues for team ${team.key} (${team.name})...`,
        );

        try {
          const teamResult = await this.syncTeamIssues(
            gql,
            writer,
            outputWriter,
            team,
            lookups,
            since,
            ctx.logger,
            ctx.signal,
          );
          itemsSynced += teamResult.synced;
          itemsFailed += teamResult.failed;
          errors.push(...teamResult.errors);
          ctx.logger.info(
            `Team ${team.key}: ${teamResult.synced} issues synced, ${teamResult.failed} failed`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.error(`Failed to sync team ${team.key}: ${message}`);
          errors.push({
            entity: `team:${team.key}`,
            error: message,
            retryable: isTransientError(err),
          });
          itemsFailed++;
        }

        // Checkpoint after each team for resumability
        await ctx.state.checkpoint();
      }

      // 6. Update state
      ctx.state.metadata.issueCount = itemsSynced;
      if (ctx.mode === "full") {
        ctx.state.metadata.lastFullSyncAt = new Date().toISOString();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.error(`Linear sync failed: ${message}`);
      errors.push({
        entity: "linear:sync",
        error: message,
        retryable: isTransientError(err),
      });
    }

    const durationMs = Date.now() - startTime;
    ctx.logger.info(
      `Linear sync completed in ${(durationMs / 1000).toFixed(1)}s: ${itemsSynced} synced, ${itemsFailed} failed`,
    );

    return {
      adapter: this.name,
      mode: ctx.mode,
      itemsSynced,
      itemsFailed,
      errors,
      durationMs,
    };
  }

  // ─── Metadata Fetching ───

  private async fetchMetadata(
    gql: LinearGraphQLClient,
    writer: LinearWriter,
    logger: Logger,
  ): Promise<LookupMaps> {
    // Fetch teams
    logger.info("Fetching teams...");
    const teamNodes = await gql.paginate<
      TeamsResponse,
      TeamsResponse["teams"]["nodes"][0]
    >(TEAMS_QUERY, {}, (r) => r.teams);
    const teams: TeamRecord[] = teamNodes.map((n) => ({
      id: n.id,
      key: n.key,
      name: n.name,
    }));
    await writer.writeTeams(teams);
    logger.info(`Fetched ${teams.length} teams`);

    // Fetch users
    logger.info("Fetching users...");
    const userNodes = await gql.paginate<
      UsersResponse,
      UsersResponse["users"]["nodes"][0]
    >(USERS_QUERY, {}, (r) => r.users);
    const users: UserRecord[] = userNodes.map((n) => ({
      id: n.id,
      name: n.name,
      email: n.email,
      displayName: n.displayName,
      avatarUrl: n.avatarUrl ?? undefined,
      active: n.active,
    }));
    await writer.writeUsers(users);
    logger.info(`Fetched ${users.length} users`);

    // Fetch labels
    logger.info("Fetching labels...");
    const labelNodes = await gql.paginate<
      LabelsResponse,
      LabelsResponse["issueLabels"]["nodes"][0]
    >(LABELS_QUERY, {}, (r) => r.issueLabels);
    const labels: LabelRecord[] = labelNodes.map((n) => ({
      id: n.id,
      name: n.name,
      color: n.color,
      parentId: n.parent?.id,
    }));
    await writer.writeLabels(labels);
    logger.info(`Fetched ${labels.length} labels`);

    // Fetch workflow states per team
    logger.info("Fetching workflow states...");
    const allStates: WorkflowStateRecord[] = [];
    for (const team of teams) {
      const stateNodes = await gql.paginate<
        TeamStatesResponse,
        TeamStatesResponse["team"]["states"]["nodes"][0]
      >(WORKFLOW_STATES_QUERY, { teamId: team.id }, (r) => r.team.states);
      for (const n of stateNodes) {
        allStates.push({
          id: n.id,
          name: n.name,
          type: n.type,
          teamId: team.id,
          color: n.color,
          position: n.position,
        });
      }
    }
    await writer.writeWorkflowStates(allStates);
    logger.info(`Fetched ${allStates.length} workflow states`);

    // Fetch cycles per team
    logger.info("Fetching cycles...");
    const allCycles: CycleRecord[] = [];
    for (const team of teams) {
      const cycleNodes = await gql.paginate<
        TeamCyclesResponse,
        TeamCyclesResponse["team"]["cycles"]["nodes"][0]
      >(CYCLES_QUERY, { teamId: team.id }, (r) => r.team.cycles);
      for (const n of cycleNodes) {
        allCycles.push({
          id: n.id,
          number: n.number,
          name: n.name ?? undefined,
          teamId: team.id,
          startsAt: n.startsAt,
          endsAt: n.endsAt,
          completedAt: n.completedAt ?? undefined,
        });
      }
    }
    await writer.writeCycles(allCycles);
    logger.info(`Fetched ${allCycles.length} cycles`);

    // Build lookup maps
    const lookups: LookupMaps = {
      teams: new Map(teams.map((t) => [t.id, t])),
      users: new Map(users.map((u) => [u.id, u])),
      labels: new Map(labels.map((l) => [l.id, l])),
      states: new Map(allStates.map((s) => [s.id, s])),
      cycles: new Map(allCycles.map((c) => [c.id, c])),
      projects: new Map(), // populated after project sync
    };

    return lookups;
  }

  private filterTeams(lookups: LookupMaps, logger: Logger): TeamRecord[] {
    const allTeams = Array.from(lookups.teams.values());

    if (!this.config.teamKeys || this.config.teamKeys.length === 0) {
      return allTeams;
    }

    const filtered = allTeams.filter((t) =>
      this.config.teamKeys?.includes(t.key),
    );

    if (filtered.length === 0) {
      logger.warn(
        `No teams match configured keys: ${this.config.teamKeys?.join(", ")}. Available: ${allTeams.map((t) => t.key).join(", ")}`,
      );
    } else {
      logger.info(
        `Syncing ${filtered.length} teams: ${filtered.map((t) => t.key).join(", ")}`,
      );
    }

    return filtered;
  }

  // ─── Project Syncing ───

  private async syncProjects(
    gql: LinearGraphQLClient,
    writer: LinearWriter,
    lookups: LookupMaps,
    logger: Logger,
  ): Promise<EntitySyncResult> {
    const result: EntitySyncResult = { synced: 0, failed: 0, errors: [] };

    try {
      const projectNodes = await gql.paginate<
        ProjectsResponse,
        ProjectsResponse["projects"]["nodes"][0]
      >(PROJECTS_QUERY, {}, (r) => r.projects);

      for (const node of projectNodes) {
        try {
          const project: ProjectRecord = {
            id: node.id,
            name: node.name,
            slug: node.slugId || slugify(node.name),
            description: node.description ?? undefined,
            state: node.state,
            startDate: node.startDate ?? undefined,
            targetDate: node.targetDate ?? undefined,
            teamIds: node.teams.nodes.map((t) => t.id),
            leadId: node.lead?.id,
          };

          lookups.projects.set(project.id, project);
          await writer.writeProject(project, lookups);
          result.synced++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Failed to write project ${node.name}: ${message}`);
          result.errors.push({
            entity: `project:${node.name}`,
            error: message,
            retryable: false,
          });
          result.failed++;
        }
      }

      logger.info(`Synced ${result.synced} projects`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to fetch projects: ${message}`);
      result.errors.push({
        entity: "projects",
        error: message,
        retryable: isTransientError(err),
      });
      result.failed++;
    }

    return result;
  }

  // ─── Issue Syncing ───

  private async syncTeamIssues(
    gql: LinearGraphQLClient,
    writer: LinearWriter,
    outputWriter: OutputWriter,
    team: TeamRecord,
    lookups: LookupMaps,
    since: string | undefined,
    logger: Logger,
    signal: AbortSignal,
  ): Promise<EntitySyncResult> {
    const result: EntitySyncResult = { synced: 0, failed: 0, errors: [] };

    const query = since ? TEAM_ISSUES_INCREMENTAL_QUERY : TEAM_ISSUES_QUERY;
    const variables: Record<string, unknown> = { teamId: team.id };
    if (since) {
      variables.since = since;
    }

    const totalProcessed = await gql.paginateWithCallback<
      TeamIssuesResponse,
      IssueNode
    >(
      query,
      variables,
      (r) => r.team.issues,
      async (issueNodes) => {
        for (const node of issueNodes) {
          if (signal.aborted) break;

          try {
            const issue = await this.processIssueNode(
              gql,
              node,
              team.id,
              logger,
            );
            await writer.writeIssue(issue, team.key, lookups);

            // Download attachments if enabled
            if (this.config.downloadAttachments) {
              await this.downloadIssueAttachments(
                gql,
                outputWriter,
                issue,
                logger,
              );
            }

            result.synced++;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(
              `Failed to process issue ${node.identifier}: ${message}`,
            );
            result.errors.push({
              entity: `issue:${node.identifier}`,
              error: message,
              retryable: isTransientError(err),
            });
            result.failed++;
          }
        }
      },
    );

    logger.info(`Processed ${totalProcessed} issue nodes for team ${team.key}`);
    return result;
  }

  /**
   * Convert a raw GraphQL issue node into an IssueRecord,
   * handling extra comment pagination if needed.
   */
  private async processIssueNode(
    gql: LinearGraphQLClient,
    node: IssueNode,
    teamId: string,
    logger: Logger,
  ): Promise<IssueRecord> {
    // Convert comments
    let comments: CommentRecord[] = node.comments.nodes.map((c) => ({
      id: c.id,
      body: c.body,
      userId: c.user?.id ?? "",
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));

    // Fetch remaining comments if paginated
    if (
      node.comments.pageInfo.hasNextPage &&
      node.comments.pageInfo.endCursor
    ) {
      logger.info(`Fetching additional comments for ${node.identifier}...`);
      const extraComments = await this.fetchRemainingComments(
        gql,
        node.id,
        node.comments.pageInfo.endCursor,
      );
      comments = comments.concat(extraComments);
    }

    // Convert attachments
    const attachments: AttachmentRecord[] = node.attachments.nodes.map((a) => ({
      id: a.id,
      title: a.title,
      url: a.url,
      sourceType: a.sourceType ?? undefined,
      createdAt: a.createdAt,
    }));

    // Build relations from both directions
    const relations: IssueRelation[] = [];

    for (const rel of node.relations.nodes) {
      relations.push({
        type: rel.type,
        relatedIssueId: rel.relatedIssue.id,
        relatedIssueIdentifier: rel.relatedIssue.identifier,
      });
    }

    for (const inv of node.inverseRelations.nodes) {
      const inverseType = INVERSE_RELATION_TYPES[inv.type] ?? inv.type;
      relations.push({
        type: inverseType,
        relatedIssueId: inv.issue.id,
        relatedIssueIdentifier: inv.issue.identifier,
      });
    }

    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? undefined,
      stateId: node.state.id,
      stateName: node.state.name,
      stateType: node.state.type,
      priority: node.priority,
      assigneeId: node.assignee?.id,
      creatorId: node.creator?.id,
      teamId,
      projectId: node.project?.id,
      cycleId: node.cycle?.id,
      labelIds: node.labels.nodes.map((l) => l.id),
      parentId: node.parent?.id,
      parentIdentifier: node.parent?.identifier,
      estimate: node.estimate ?? undefined,
      dueDate: node.dueDate ?? undefined,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
      archivedAt: node.archivedAt ?? undefined,
      completedAt: node.completedAt ?? undefined,
      canceledAt: node.canceledAt ?? undefined,
      relations,
      comments,
      attachments,
    };
  }

  private async fetchRemainingComments(
    gql: LinearGraphQLClient,
    issueId: string,
    startCursor: string,
  ): Promise<CommentRecord[]> {
    const comments: CommentRecord[] = [];
    let cursor: string | undefined = startCursor;

    do {
      const result: IssueCommentsResponse =
        await gql.request<IssueCommentsResponse>(ISSUE_COMMENTS_QUERY, {
          issueId,
          after: cursor,
        });

      const page: IssueCommentsResponse["issue"]["comments"] =
        result.issue.comments;
      for (const c of page.nodes) {
        comments.push({
          id: c.id,
          body: c.body,
          userId: c.user?.id ?? "",
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        });
      }

      cursor =
        page.pageInfo.hasNextPage && page.pageInfo.endCursor
          ? page.pageInfo.endCursor
          : undefined;
    } while (cursor);

    return comments;
  }

  // ─── Attachment Downloads ───

  private async downloadIssueAttachments(
    gql: LinearGraphQLClient,
    outputWriter: OutputWriter,
    issue: IssueRecord,
    logger: Logger,
  ): Promise<void> {
    for (const attachment of issue.attachments) {
      // Only download uploaded files, not external links
      if (!isDownloadableAttachment(attachment.sourceType)) {
        continue;
      }

      try {
        const filename =
          extractFilenameFromUrl(attachment.url) ??
          sanitizeAttachmentTitle(attachment.title);
        const data = await gql.downloadBinary(attachment.url);

        if (data) {
          const safeName = sanitizeAttachmentFilename(filename);
          const relativePath = `attachments/${issue.identifier}/${safeName}`;
          await outputWriter.writeBinary(relativePath, data);
          logger.info(
            `Downloaded attachment ${safeName} for ${issue.identifier}`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Failed to download attachment "${attachment.title}" for ${issue.identifier}: ${message}`,
        );
        // Non-fatal: continue with other attachments
      }
    }
  }
}

// ─── Helper Types ───

interface EntitySyncResult {
  synced: number;
  failed: number;
  errors: SyncError[];
}

// ─── Helper Functions ───

function parseCommaSeparated(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function parseBoolEnv(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() !== "false" && value !== "0";
}

function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("fetch failed") ||
      msg.includes("socket hang up") ||
      msg.includes("429") ||
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504")
    ) {
      return true;
    }
  }
  return false;
}

function isDownloadableAttachment(sourceType: string | undefined): boolean {
  // null/undefined or "upload" means it's a file uploaded to Linear
  // Other values like "figma", "github", "sentry" are external links
  return sourceType == null || sourceType === "" || sourceType === "upload";
}

function extractFilenameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last?.includes(".")) {
      return decodeURIComponent(last);
    }
  } catch {
    // invalid URL, fall through
  }
  return null;
}

function sanitizeAttachmentTitle(title: string): string {
  return (
    title.replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, "_") || "attachment"
  );
}

function sanitizeAttachmentFilename(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 200) || "attachment"
  );
}
