/**
 * Output writer for the Linear adapter.
 * Converts Linear records into markdown documents and JSON metadata files.
 */

import type { Logger, OutputWriter } from "../core/index.js";
import { sanitizeFilename } from "../core/index.js";
import type {
  CycleRecord,
  IssueRecord,
  LabelRecord,
  LookupMaps,
  ProjectRecord,
  TeamRecord,
  UserRecord,
  WorkflowStateRecord,
} from "./types.js";
import { PRIORITY_LABELS } from "./types.js";

export class LinearWriter {
  private readonly writer: OutputWriter;

  constructor(writer: OutputWriter, _logger: Logger) {
    this.writer = writer;
  }

  // ─── Meta files ───

  async writeTeams(teams: TeamRecord[]): Promise<void> {
    await this.writer.writeMeta(
      "_meta/teams.json",
      teams as unknown as Record<string, unknown>,
    );
  }

  async writeUsers(users: UserRecord[]): Promise<void> {
    await this.writer.writeMeta(
      "_meta/users.json",
      users as unknown as Record<string, unknown>,
    );
  }

  async writeLabels(labels: LabelRecord[]): Promise<void> {
    await this.writer.writeMeta(
      "_meta/labels.json",
      labels as unknown as Record<string, unknown>,
    );
  }

  async writeWorkflowStates(states: WorkflowStateRecord[]): Promise<void> {
    await this.writer.writeMeta(
      "_meta/workflow-states.json",
      states as unknown as Record<string, unknown>,
    );
  }

  async writeCycles(cycles: CycleRecord[]): Promise<void> {
    await this.writer.writeMeta(
      "_meta/cycles.json",
      cycles as unknown as Record<string, unknown>,
    );
  }

  // ─── Project files ───

  async writeProject(
    project: ProjectRecord,
    lookups: LookupMaps,
  ): Promise<void> {
    const slug =
      project.slug ||
      sanitizeFilename(project.name.toLowerCase().replace(/\s+/g, "-"));
    const relativePath = `projects/${slug}.md`;

    const leadName = project.leadId
      ? lookups.users.get(project.leadId)?.displayName
      : undefined;
    const teamNames = project.teamIds
      .map((id) => lookups.teams.get(id)?.name)
      .filter(Boolean);

    const frontmatter: Record<string, unknown> = {
      id: project.id,
      name: project.name,
      slug: project.slug,
      state: project.state,
    };

    if (leadName) frontmatter.lead = leadName;
    if (teamNames.length > 0) frontmatter.teams = teamNames;
    if (project.startDate) frontmatter.startDate = project.startDate;
    if (project.targetDate) frontmatter.targetDate = project.targetDate;

    const body = `# ${project.name}\n\n${project.description || ""}`;
    await this.writer.writeDocument(relativePath, frontmatter, body);
  }

  // ─── Issue files ───

  async writeIssue(
    issue: IssueRecord,
    teamKey: string,
    lookups: LookupMaps,
  ): Promise<void> {
    const relativePath = `issues/${teamKey}/${issue.identifier}.md`;

    const frontmatter = this.buildIssueFrontmatter(issue, lookups);
    const body = this.buildIssueBody(issue, lookups);

    await this.writer.writeDocument(relativePath, frontmatter, body);
  }

  private buildIssueFrontmatter(
    issue: IssueRecord,
    lookups: LookupMaps,
  ): Record<string, unknown> {
    const assigneeName = issue.assigneeId
      ? lookups.users.get(issue.assigneeId)?.displayName
      : undefined;
    const creatorName = issue.creatorId
      ? lookups.users.get(issue.creatorId)?.displayName
      : undefined;
    const teamName = lookups.teams.get(issue.teamId)?.name;
    const projectName = issue.projectId
      ? lookups.projects.get(issue.projectId)?.name
      : undefined;
    const cycleName = issue.cycleId
      ? formatCycleName(lookups.cycles.get(issue.cycleId))
      : undefined;
    const labelNames = issue.labelIds
      .map((id) => lookups.labels.get(id)?.name)
      .filter(Boolean) as string[];

    const fm: Record<string, unknown> = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.stateName,
      stateType: issue.stateType,
      priority: issue.priority,
      priorityLabel: PRIORITY_LABELS[issue.priority] ?? "None",
    };

    if (assigneeName) fm.assignee = assigneeName;
    if (creatorName) fm.creator = creatorName;
    if (teamName) fm.team = teamName;
    if (projectName) fm.project = projectName;
    if (cycleName) fm.cycle = cycleName;
    if (labelNames.length > 0) fm.labels = labelNames;
    if (issue.parentIdentifier) fm.parent = issue.parentIdentifier;
    if (issue.estimate != null) fm.estimate = issue.estimate;
    if (issue.dueDate) fm.dueDate = issue.dueDate;

    fm.createdAt = issue.createdAt;
    fm.updatedAt = issue.updatedAt;
    fm.archived = issue.archivedAt != null;

    if (issue.completedAt) fm.completedAt = issue.completedAt;
    if (issue.canceledAt) fm.canceledAt = issue.canceledAt;
    if (issue.archivedAt) fm.archivedAt = issue.archivedAt;

    // Relations
    if (issue.relations.length > 0) {
      fm.relations = issue.relations.map((r) => ({
        type: r.type,
        issue: r.relatedIssueIdentifier,
      }));
    }

    // Attachments (metadata only in frontmatter)
    if (issue.attachments.length > 0) {
      fm.attachments = issue.attachments.map((a) => ({
        title: a.title,
        url: a.url,
      }));
    }

    return fm;
  }

  private buildIssueBody(issue: IssueRecord, lookups: LookupMaps): string {
    const parts: string[] = [];

    // Title
    parts.push(`# ${issue.identifier}: ${issue.title}`);
    parts.push("");

    // Description
    if (issue.description) {
      parts.push(issue.description);
    }

    // Comments
    if (issue.comments.length > 0) {
      parts.push("");
      parts.push("---");
      parts.push("");
      parts.push("## Comments");

      for (const comment of issue.comments) {
        const userName = comment.userId
          ? (lookups.users.get(comment.userId)?.displayName ?? "Unknown")
          : "Unknown";
        parts.push("");
        parts.push(`### ${userName} --- ${comment.createdAt}`);
        parts.push("");
        parts.push(comment.body);
      }
    }

    return parts.join("\n");
  }

  // ─── Attachment binaries ───

  async writeAttachmentBinary(
    issueIdentifier: string,
    filename: string,
    data: Buffer,
  ): Promise<void> {
    const safeFilename = sanitizeFilename(filename);
    const relativePath = `attachments/${issueIdentifier}/${safeFilename}`;
    await this.writer.writeBinary(relativePath, data);
  }
}

// ─── Helpers ───

function formatCycleName(cycle: CycleRecord | undefined): string | undefined {
  if (!cycle) return undefined;
  if (cycle.name) return cycle.name;
  return `Cycle ${cycle.number}`;
}
