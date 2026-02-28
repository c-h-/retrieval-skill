import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger, OutputWriter } from "../../../src/connectors/core/index.js";
import { createLogger, createOutputWriter } from "../../../src/connectors/core/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CycleRecord,
  IssueRecord,
  LabelRecord,
  LookupMaps,
  ProjectRecord,
  TeamRecord,
  UserRecord,
  WorkflowStateRecord,
} from "../../../src/connectors/linear/types.js";
import { LinearWriter } from "../../../src/connectors/linear/writer.js";

// ─── Helpers ───

function makeLookupMaps(overrides: Partial<LookupMaps> = {}): LookupMaps {
  return {
    teams: overrides.teams ?? new Map(),
    users: overrides.users ?? new Map(),
    labels: overrides.labels ?? new Map(),
    states: overrides.states ?? new Map(),
    cycles: overrides.cycles ?? new Map(),
    projects: overrides.projects ?? new Map(),
  };
}

function makeTeam(partial: Partial<TeamRecord> = {}): TeamRecord {
  return { id: "team-1", key: "ENG", name: "Engineering", ...partial };
}

function makeUser(partial: Partial<UserRecord> = {}): UserRecord {
  return {
    id: "user-1",
    name: "Alice Smith",
    email: "alice@example.com",
    displayName: "Alice",
    active: true,
    ...partial,
  };
}

function makeLabel(partial: Partial<LabelRecord> = {}): LabelRecord {
  return { id: "label-1", name: "Bug", color: "#ff0000", ...partial };
}

function makeState(
  partial: Partial<WorkflowStateRecord> = {},
): WorkflowStateRecord {
  return {
    id: "state-1",
    name: "In Progress",
    type: "started",
    teamId: "team-1",
    color: "#f59e0b",
    position: 1,
    ...partial,
  };
}

function makeCycle(partial: Partial<CycleRecord> = {}): CycleRecord {
  return {
    id: "cycle-1",
    number: 5,
    teamId: "team-1",
    startsAt: "2024-01-01T00:00:00.000Z",
    endsAt: "2024-01-14T00:00:00.000Z",
    ...partial,
  };
}

function makeProject(partial: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "proj-1",
    name: "Project Alpha",
    slug: "project-alpha",
    state: "started",
    teamIds: ["team-1"],
    ...partial,
  };
}

function makeIssue(partial: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: "issue-1",
    identifier: "ENG-42",
    title: "Fix login bug",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    teamId: "team-1",
    labelIds: [],
    relations: [],
    comments: [],
    attachments: [],
    createdAt: "2024-01-10T10:00:00.000Z",
    updatedAt: "2024-01-11T15:30:00.000Z",
    ...partial,
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

// ─── Test suite ───

describe("LinearWriter", () => {
  let tmpDir: string;
  let outputWriter: OutputWriter;
  let logger: Logger;
  let writer: LinearWriter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "linear-writer-test-"));
    outputWriter = createOutputWriter(tmpDir);
    logger = createLogger("linear-test");
    writer = new LinearWriter(outputWriter, logger);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Meta: writeTeams ───

  describe("writeTeams", () => {
    it("writes an empty array", async () => {
      await writer.writeTeams([]);
      const data = readJson(path.join(tmpDir, "_meta/teams.json"));
      expect(data).toEqual([]);
    });

    it("writes a single team", async () => {
      const teams = [makeTeam()];
      await writer.writeTeams(teams);
      const data = readJson(path.join(tmpDir, "_meta/teams.json"));
      expect(data).toEqual([{ id: "team-1", key: "ENG", name: "Engineering" }]);
    });

    it("writes multiple teams", async () => {
      const teams = [
        makeTeam({ id: "t1", key: "ENG", name: "Engineering" }),
        makeTeam({ id: "t2", key: "DES", name: "Design" }),
        makeTeam({ id: "t3", key: "OPS", name: "Operations" }),
      ];
      await writer.writeTeams(teams);
      const data = readJson(
        path.join(tmpDir, "_meta/teams.json"),
      ) as TeamRecord[];
      expect(data).toHaveLength(3);
      expect(data[0].key).toBe("ENG");
      expect(data[1].key).toBe("DES");
      expect(data[2].key).toBe("OPS");
    });

    it("overwrites existing teams file", async () => {
      await writer.writeTeams([makeTeam({ id: "old" })]);
      await writer.writeTeams([makeTeam({ id: "new" })]);
      const data = readJson(
        path.join(tmpDir, "_meta/teams.json"),
      ) as TeamRecord[];
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("new");
    });
  });

  // ─── Meta: writeUsers ───

  describe("writeUsers", () => {
    it("writes an empty array", async () => {
      await writer.writeUsers([]);
      const data = readJson(path.join(tmpDir, "_meta/users.json"));
      expect(data).toEqual([]);
    });

    it("writes users with all fields", async () => {
      const users = [
        makeUser({ avatarUrl: "https://example.com/avatar.png" }),
        makeUser({
          id: "user-2",
          name: "Bob",
          email: "bob@example.com",
          displayName: "Bob",
          active: false,
        }),
      ];
      await writer.writeUsers(users);
      const data = readJson(
        path.join(tmpDir, "_meta/users.json"),
      ) as UserRecord[];
      expect(data).toHaveLength(2);
      expect(data[0].avatarUrl).toBe("https://example.com/avatar.png");
      expect(data[1].active).toBe(false);
    });

    it("writes users without optional avatarUrl", async () => {
      const users = [makeUser()];
      await writer.writeUsers(users);
      const data = readJson(
        path.join(tmpDir, "_meta/users.json"),
      ) as UserRecord[];
      expect(data[0].avatarUrl).toBeUndefined();
    });
  });

  // ─── Meta: writeLabels ───

  describe("writeLabels", () => {
    it("writes an empty array", async () => {
      await writer.writeLabels([]);
      const data = readJson(path.join(tmpDir, "_meta/labels.json"));
      expect(data).toEqual([]);
    });

    it("writes labels with optional parentId", async () => {
      const labels = [
        makeLabel({ id: "l1", name: "Bug", parentId: undefined }),
        makeLabel({ id: "l2", name: "UI Bug", parentId: "l1" }),
      ];
      await writer.writeLabels(labels);
      const data = readJson(
        path.join(tmpDir, "_meta/labels.json"),
      ) as LabelRecord[];
      expect(data).toHaveLength(2);
      expect(data[0].parentId).toBeUndefined();
      expect(data[1].parentId).toBe("l1");
    });
  });

  // ─── Meta: writeWorkflowStates ───

  describe("writeWorkflowStates", () => {
    it("writes an empty array", async () => {
      await writer.writeWorkflowStates([]);
      const data = readJson(path.join(tmpDir, "_meta/workflow-states.json"));
      expect(data).toEqual([]);
    });

    it("writes workflow states preserving all fields", async () => {
      const states = [
        makeState({ id: "s1", name: "Backlog", type: "backlog", position: 0 }),
        makeState({
          id: "s2",
          name: "In Progress",
          type: "started",
          position: 1,
        }),
        makeState({ id: "s3", name: "Done", type: "completed", position: 2 }),
      ];
      await writer.writeWorkflowStates(states);
      const data = readJson(
        path.join(tmpDir, "_meta/workflow-states.json"),
      ) as WorkflowStateRecord[];
      expect(data).toHaveLength(3);
      expect(data[0].type).toBe("backlog");
      expect(data[1].type).toBe("started");
      expect(data[2].type).toBe("completed");
    });
  });

  // ─── Meta: writeCycles ───

  describe("writeCycles", () => {
    it("writes an empty array", async () => {
      await writer.writeCycles([]);
      const data = readJson(path.join(tmpDir, "_meta/cycles.json"));
      expect(data).toEqual([]);
    });

    it("writes cycles with optional fields", async () => {
      const cycles = [
        makeCycle({
          name: "Sprint 5",
          completedAt: "2024-01-14T00:00:00.000Z",
        }),
        makeCycle({ id: "cycle-2", number: 6 }),
      ];
      await writer.writeCycles(cycles);
      const data = readJson(
        path.join(tmpDir, "_meta/cycles.json"),
      ) as CycleRecord[];
      expect(data).toHaveLength(2);
      expect(data[0].name).toBe("Sprint 5");
      expect(data[0].completedAt).toBe("2024-01-14T00:00:00.000Z");
      expect(data[1].name).toBeUndefined();
      expect(data[1].completedAt).toBeUndefined();
    });
  });

  // ─── Projects ───

  describe("writeProject", () => {
    it("writes a basic project markdown file", async () => {
      const project = makeProject();
      const lookups = makeLookupMaps();
      await writer.writeProject(project, lookups);

      const filePath = path.join(tmpDir, "projects/project-alpha.md");
      expect(fs.existsSync(filePath)).toBe(true);

      const content = readText(filePath);
      expect(content).toContain("---");
      expect(content).toContain("id: proj-1");
      expect(content).toContain("name: Project Alpha");
      expect(content).toContain("slug: project-alpha");
      expect(content).toContain("state: started");
      expect(content).toContain("# Project Alpha");
    });

    it("includes lead name from lookups", async () => {
      const user = makeUser({ id: "lead-1", displayName: "Alice Lead" });
      const project = makeProject({ leadId: "lead-1" });
      const lookups = makeLookupMaps({
        users: new Map([["lead-1", user]]),
      });
      await writer.writeProject(project, lookups);

      const content = readText(path.join(tmpDir, "projects/project-alpha.md"));
      expect(content).toContain("lead: Alice Lead");
    });

    it("does not include lead when leadId is not set", async () => {
      const project = makeProject({ leadId: undefined });
      const lookups = makeLookupMaps();
      await writer.writeProject(project, lookups);

      const content = readText(path.join(tmpDir, "projects/project-alpha.md"));
      expect(content).not.toContain("lead:");
    });

    it("does not include lead when leadId is not found in lookups", async () => {
      const project = makeProject({ leadId: "nonexistent-user" });
      const lookups = makeLookupMaps();
      await writer.writeProject(project, lookups);

      const content = readText(path.join(tmpDir, "projects/project-alpha.md"));
      expect(content).not.toContain("lead:");
    });

    it("includes team names from lookups", async () => {
      const team1 = makeTeam({ id: "t1", name: "Frontend" });
      const team2 = makeTeam({ id: "t2", name: "Backend" });
      const project = makeProject({ teamIds: ["t1", "t2"] });
      const lookups = makeLookupMaps({
        teams: new Map([
          ["t1", team1],
          ["t2", team2],
        ]),
      });
      await writer.writeProject(project, lookups);

      const content = readText(path.join(tmpDir, "projects/project-alpha.md"));
      expect(content).toContain("Frontend");
      expect(content).toContain("Backend");
    });

    it("filters out teams not found in lookups", async () => {
      const team1 = makeTeam({ id: "t1", name: "Frontend" });
      const project = makeProject({ teamIds: ["t1", "t-missing"] });
      const lookups = makeLookupMaps({
        teams: new Map([["t1", team1]]),
      });
      await writer.writeProject(project, lookups);

      const content = readText(path.join(tmpDir, "projects/project-alpha.md"));
      expect(content).toContain("Frontend");
      expect(content).not.toContain("t-missing");
    });

    it("includes date fields when present", async () => {
      const project = makeProject({
        startDate: "2024-01-01",
        targetDate: "2024-06-30",
      });
      const lookups = makeLookupMaps();
      await writer.writeProject(project, lookups);

      const content = readText(path.join(tmpDir, "projects/project-alpha.md"));
      expect(content).toContain("startDate:");
      expect(content).toContain("2024-01-01");
      expect(content).toContain("targetDate:");
      expect(content).toContain("2024-06-30");
    });

    it("does not include date fields when not present", async () => {
      const project = makeProject({
        startDate: undefined,
        targetDate: undefined,
      });
      const lookups = makeLookupMaps();
      await writer.writeProject(project, lookups);

      const content = readText(path.join(tmpDir, "projects/project-alpha.md"));
      expect(content).not.toContain("startDate:");
      expect(content).not.toContain("targetDate:");
    });

    it("includes description in the body", async () => {
      const project = makeProject({
        description: "This is a description of the project.",
      });
      const lookups = makeLookupMaps();
      await writer.writeProject(project, lookups);

      const content = readText(path.join(tmpDir, "projects/project-alpha.md"));
      expect(content).toContain("This is a description of the project.");
    });

    it("handles empty description", async () => {
      const project = makeProject({ description: undefined });
      const lookups = makeLookupMaps();
      await writer.writeProject(project, lookups);

      const content = readText(path.join(tmpDir, "projects/project-alpha.md"));
      expect(content).toContain("# Project Alpha");
    });

    it("falls back to sanitized name when slug is empty", async () => {
      const project = makeProject({ slug: "", name: "My Cool Project" });
      const lookups = makeLookupMaps();
      await writer.writeProject(project, lookups);

      const filePath = path.join(tmpDir, "projects/my-cool-project.md");
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });

  // ─── Issues ───

  describe("writeIssue", () => {
    it("writes a basic issue file at the correct path", async () => {
      const issue = makeIssue();
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const filePath = path.join(tmpDir, "issues/ENG/ENG-42.md");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("includes core frontmatter fields", async () => {
      const issue = makeIssue();
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("id: issue-1");
      expect(content).toContain("identifier: ENG-42");
      expect(content).toContain("title: Fix login bug");
      expect(content).toContain("state: In Progress");
      expect(content).toContain("stateType: started");
      expect(content).toContain("priority: 2");
      expect(content).toContain("priorityLabel: High");
      expect(content).toContain("createdAt:");
      expect(content).toContain("updatedAt:");
      expect(content).toContain("archived: false");
    });

    it("maps priority values to correct labels", async () => {
      for (const [priority, label] of [
        [0, "None"],
        [1, "Urgent"],
        [2, "High"],
        [3, "Medium"],
        [4, "Low"],
      ] as [number, string][]) {
        const issue = makeIssue({
          id: `issue-p${priority}`,
          priority,
          identifier: `ENG-${priority}`,
        });
        const lookups = makeLookupMaps();
        await writer.writeIssue(issue, "ENG", lookups);

        const content = readText(
          path.join(tmpDir, `issues/ENG/ENG-${priority}.md`),
        );
        expect(content).toContain(`priorityLabel: ${label}`);
      }
    });

    it("falls back to None for unknown priority", async () => {
      const issue = makeIssue({ priority: 99 });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("priorityLabel: None");
    });

    it("resolves assignee name from lookups", async () => {
      const user = makeUser({ id: "u1", displayName: "Alice Dev" });
      const issue = makeIssue({ assigneeId: "u1" });
      const lookups = makeLookupMaps({ users: new Map([["u1", user]]) });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("assignee: Alice Dev");
    });

    it("does not include assignee when not set", async () => {
      const issue = makeIssue({ assigneeId: undefined });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("assignee:");
    });

    it("does not include assignee when not found in lookups", async () => {
      const issue = makeIssue({ assigneeId: "nonexistent" });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("assignee:");
    });

    it("resolves creator name from lookups", async () => {
      const user = makeUser({ id: "u2", displayName: "Bob Creator" });
      const issue = makeIssue({ creatorId: "u2" });
      const lookups = makeLookupMaps({ users: new Map([["u2", user]]) });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("creator: Bob Creator");
    });

    it("resolves team name from lookups", async () => {
      const team = makeTeam({ id: "t1", name: "Platform" });
      const issue = makeIssue({ teamId: "t1" });
      const lookups = makeLookupMaps({ teams: new Map([["t1", team]]) });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("team: Platform");
    });

    it("resolves project name from lookups", async () => {
      const project = makeProject({ id: "p1", name: "Big Feature" });
      const issue = makeIssue({ projectId: "p1" });
      const lookups = makeLookupMaps({ projects: new Map([["p1", project]]) });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("project: Big Feature");
    });

    it("does not include project when projectId is not set", async () => {
      const issue = makeIssue({ projectId: undefined });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("project:");
    });

    it("resolves cycle name from lookups when cycle has a name", async () => {
      const cycle = makeCycle({ id: "c1", name: "Sprint 5", number: 5 });
      const issue = makeIssue({ cycleId: "c1" });
      const lookups = makeLookupMaps({ cycles: new Map([["c1", cycle]]) });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("cycle: Sprint 5");
    });

    it("falls back to 'Cycle N' when cycle has no name", async () => {
      const cycle = makeCycle({ id: "c2", number: 7, name: undefined });
      const issue = makeIssue({ cycleId: "c2" });
      const lookups = makeLookupMaps({ cycles: new Map([["c2", cycle]]) });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("cycle: Cycle 7");
    });

    it("does not include cycle when cycleId is not set", async () => {
      const issue = makeIssue({ cycleId: undefined });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("cycle:");
    });

    it("does not include cycle when cycleId not found in lookups", async () => {
      const issue = makeIssue({ cycleId: "nonexistent" });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("cycle:");
    });

    it("resolves label names from lookups", async () => {
      const label1 = makeLabel({ id: "l1", name: "Bug" });
      const label2 = makeLabel({ id: "l2", name: "P0" });
      const issue = makeIssue({ labelIds: ["l1", "l2"] });
      const lookups = makeLookupMaps({
        labels: new Map([
          ["l1", label1],
          ["l2", label2],
        ]),
      });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("Bug");
      expect(content).toContain("P0");
    });

    it("does not include labels when labelIds is empty", async () => {
      const issue = makeIssue({ labelIds: [] });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("labels:");
    });

    it("filters out labels not found in lookups", async () => {
      const label1 = makeLabel({ id: "l1", name: "Bug" });
      const issue = makeIssue({ labelIds: ["l1", "l-missing"] });
      const lookups = makeLookupMaps({ labels: new Map([["l1", label1]]) });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("Bug");
    });

    it("includes parentIdentifier in frontmatter", async () => {
      const issue = makeIssue({ parentIdentifier: "ENG-10" });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("parent: ENG-10");
    });

    it("does not include parent when parentIdentifier is not set", async () => {
      const issue = makeIssue({ parentIdentifier: undefined });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("parent:");
    });

    it("includes estimate when present", async () => {
      const issue = makeIssue({ estimate: 3 });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("estimate: 3");
    });

    it("includes estimate of 0", async () => {
      const issue = makeIssue({ estimate: 0 });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("estimate: 0");
    });

    it("does not include estimate when not set", async () => {
      const issue = makeIssue({ estimate: undefined });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("estimate:");
    });

    it("includes dueDate when present", async () => {
      const issue = makeIssue({ dueDate: "2024-03-15" });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("dueDate:");
      expect(content).toContain("2024-03-15");
    });

    it("sets archived to true when archivedAt is set", async () => {
      const issue = makeIssue({ archivedAt: "2024-02-01T00:00:00.000Z" });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("archived: true");
      expect(content).toContain("archivedAt:");
    });

    it("sets archived to false when archivedAt is not set", async () => {
      const issue = makeIssue({ archivedAt: undefined });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("archived: false");
      expect(content).not.toContain("archivedAt:");
    });

    it("includes completedAt when present", async () => {
      const issue = makeIssue({ completedAt: "2024-01-15T00:00:00.000Z" });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("completedAt:");
    });

    it("includes canceledAt when present", async () => {
      const issue = makeIssue({ canceledAt: "2024-01-20T00:00:00.000Z" });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("canceledAt:");
    });

    it("includes relations in frontmatter", async () => {
      const issue = makeIssue({
        relations: [
          {
            type: "blocks",
            relatedIssueId: "iss-2",
            relatedIssueIdentifier: "ENG-99",
          },
          {
            type: "related",
            relatedIssueId: "iss-3",
            relatedIssueIdentifier: "DES-5",
          },
        ],
      });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("relations:");
      expect(content).toContain("type: blocks");
      expect(content).toContain("issue: ENG-99");
      expect(content).toContain("type: related");
      expect(content).toContain("issue: DES-5");
    });

    it("does not include relations when empty", async () => {
      const issue = makeIssue({ relations: [] });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("relations:");
    });

    it("includes attachments in frontmatter", async () => {
      const issue = makeIssue({
        attachments: [
          {
            id: "att-1",
            title: "Screenshot",
            url: "https://example.com/img.png",
            createdAt: "2024-01-10T00:00:00.000Z",
          },
          {
            id: "att-2",
            title: "Log file",
            url: "https://example.com/log.txt",
            createdAt: "2024-01-11T00:00:00.000Z",
          },
        ],
      });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("attachments:");
      expect(content).toContain("title: Screenshot");
      expect(content).toContain("url: https://example.com/img.png");
      expect(content).toContain("title: Log file");
    });

    it("does not include attachments when empty", async () => {
      const issue = makeIssue({ attachments: [] });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("attachments:");
    });

    // ─── Body ───

    it("writes issue title as heading in body", async () => {
      const issue = makeIssue();
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("# ENG-42: Fix login bug");
    });

    it("includes description in body", async () => {
      const issue = makeIssue({
        description: "The login form crashes when submitting.",
      });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("The login form crashes when submitting.");
    });

    it("omits description section when not set", async () => {
      const issue = makeIssue({ description: undefined });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      // Body should just have the heading followed by empty content
      const bodyPart = content.split("---").pop()!;
      expect(bodyPart.trim()).toBe("# ENG-42: Fix login bug");
    });

    it("includes comments section with user names and timestamps", async () => {
      const user = makeUser({ id: "u1", displayName: "Alice" });
      const issue = makeIssue({
        comments: [
          {
            id: "c1",
            body: "Looks good to me!",
            userId: "u1",
            createdAt: "2024-01-12T10:00:00.000Z",
            updatedAt: "2024-01-12T10:00:00.000Z",
          },
        ],
      });
      const lookups = makeLookupMaps({ users: new Map([["u1", user]]) });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("## Comments");
      expect(content).toContain("### Alice --- 2024-01-12T10:00:00.000Z");
      expect(content).toContain("Looks good to me!");
    });

    it("uses 'Unknown' for comments from unknown users", async () => {
      const issue = makeIssue({
        comments: [
          {
            id: "c1",
            body: "A comment",
            userId: "unknown-user",
            createdAt: "2024-01-12T10:00:00.000Z",
            updatedAt: "2024-01-12T10:00:00.000Z",
          },
        ],
      });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("### Unknown --- 2024-01-12T10:00:00.000Z");
    });

    it("renders multiple comments in order", async () => {
      const user1 = makeUser({ id: "u1", displayName: "Alice" });
      const user2 = makeUser({ id: "u2", displayName: "Bob" });
      const issue = makeIssue({
        comments: [
          {
            id: "c1",
            body: "First comment",
            userId: "u1",
            createdAt: "2024-01-12T10:00:00.000Z",
            updatedAt: "2024-01-12T10:00:00.000Z",
          },
          {
            id: "c2",
            body: "Second comment",
            userId: "u2",
            createdAt: "2024-01-13T11:00:00.000Z",
            updatedAt: "2024-01-13T11:00:00.000Z",
          },
        ],
      });
      const lookups = makeLookupMaps({
        users: new Map([
          ["u1", user1],
          ["u2", user2],
        ]),
      });
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      const firstIdx = content.indexOf("First comment");
      const secondIdx = content.indexOf("Second comment");
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(content).toContain("### Alice ---");
      expect(content).toContain("### Bob ---");
    });

    it("does not include comments section when there are no comments", async () => {
      const issue = makeIssue({ comments: [] });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).not.toContain("## Comments");
    });

    it("includes a separator before comments", async () => {
      const issue = makeIssue({
        description: "Some description",
        comments: [
          {
            id: "c1",
            body: "A comment",
            userId: "u1",
            createdAt: "2024-01-12T10:00:00.000Z",
            updatedAt: "2024-01-12T10:00:00.000Z",
          },
        ],
      });
      const lookups = makeLookupMaps();
      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      // The body portion should contain "---" as a horizontal rule separator before "## Comments"
      // Use a regex to find a --- line that appears between the description and comments heading
      const commentsIdx = content.indexOf("## Comments");
      expect(commentsIdx).toBeGreaterThan(-1);
      // Look for a standalone "---" line before "## Comments" but after the frontmatter closing
      // The frontmatter ends with "---\n\n", and after the body description there should be "\n---\n"
      const descriptionIdx = content.indexOf("Some description");
      const separatorInBody = content.indexOf("\n---\n", descriptionIdx);
      expect(separatorInBody).toBeGreaterThan(descriptionIdx);
      expect(separatorInBody).toBeLessThan(commentsIdx);
    });

    // ─── Full integration: issue with all optional fields ───

    it("writes a fully-populated issue with all fields resolved", async () => {
      const team = makeTeam({ id: "t1", name: "Platform" });
      const assignee = makeUser({ id: "u1", displayName: "Alice" });
      const creator = makeUser({ id: "u2", displayName: "Bob" });
      const label = makeLabel({ id: "l1", name: "Bug" });
      const cycle = makeCycle({ id: "c1", name: "Sprint 1", number: 1 });
      const project = makeProject({ id: "p1", name: "Migration" });

      const issue = makeIssue({
        assigneeId: "u1",
        creatorId: "u2",
        teamId: "t1",
        projectId: "p1",
        cycleId: "c1",
        labelIds: ["l1"],
        parentIdentifier: "ENG-10",
        estimate: 5,
        dueDate: "2024-03-01",
        description: "Detailed description here.",
        completedAt: "2024-02-28T00:00:00.000Z",
        archivedAt: "2024-03-01T00:00:00.000Z",
        relations: [
          {
            type: "blocks",
            relatedIssueId: "iss-2",
            relatedIssueIdentifier: "ENG-99",
          },
        ],
        attachments: [
          {
            id: "att-1",
            title: "Design doc",
            url: "https://example.com/doc",
            createdAt: "2024-01-10T00:00:00.000Z",
          },
        ],
        comments: [
          {
            id: "cm1",
            body: "LGTM",
            userId: "u1",
            createdAt: "2024-01-15T00:00:00.000Z",
            updatedAt: "2024-01-15T00:00:00.000Z",
          },
        ],
      });

      const lookups = makeLookupMaps({
        teams: new Map([["t1", team]]),
        users: new Map([
          ["u1", assignee],
          ["u2", creator],
        ]),
        labels: new Map([["l1", label]]),
        cycles: new Map([["c1", cycle]]),
        projects: new Map([["p1", project]]),
      });

      await writer.writeIssue(issue, "ENG", lookups);

      const content = readText(path.join(tmpDir, "issues/ENG/ENG-42.md"));
      expect(content).toContain("assignee: Alice");
      expect(content).toContain("creator: Bob");
      expect(content).toContain("team: Platform");
      expect(content).toContain("project: Migration");
      expect(content).toContain("cycle: Sprint 1");
      expect(content).toContain("Bug");
      expect(content).toContain("parent: ENG-10");
      expect(content).toContain("estimate: 5");
      expect(content).toContain("archived: true");
      expect(content).toContain("completedAt:");
      expect(content).toContain("archivedAt:");
      expect(content).toContain("Detailed description here.");
      expect(content).toContain("## Comments");
      expect(content).toContain("LGTM");
      expect(content).toContain("relations:");
      expect(content).toContain("attachments:");
    });
  });

  // ─── writeAttachmentBinary ───

  describe("writeAttachmentBinary", () => {
    it("writes binary data to the correct path", async () => {
      const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      await writer.writeAttachmentBinary("ENG-42", "screenshot.png", data);

      const filePath = path.join(tmpDir, "attachments/ENG-42/screenshot.png");
      expect(fs.existsSync(filePath)).toBe(true);
      const written = fs.readFileSync(filePath);
      expect(written).toEqual(data);
    });

    it("sanitizes the filename", async () => {
      const data = Buffer.from("test content");
      await writer.writeAttachmentBinary(
        "ENG-42",
        "file with spaces.txt",
        data,
      );

      const filePath = path.join(
        tmpDir,
        "attachments/ENG-42/file_with_spaces.txt",
      );
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("handles special characters in filename", async () => {
      const data = Buffer.from("data");
      await writer.writeAttachmentBinary("ENG-42", "my:file*name?.txt", data);

      const filePath = path.join(
        tmpDir,
        "attachments/ENG-42/my_file_name_.txt",
      );
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });
});
