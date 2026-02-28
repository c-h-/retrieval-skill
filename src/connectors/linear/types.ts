/** Linear adapter type definitions. */

// ─── Configuration ───

export interface LinearConfig {
  apiKey: string;
  teamKeys?: string[];
  includeArchived?: boolean;
  downloadAttachments?: boolean;
}

// ─── Persisted Records (written to _meta/*.json) ───

export interface TeamRecord {
  id: string;
  key: string;
  name: string;
}

export interface UserRecord {
  id: string;
  name: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  active: boolean;
}

export interface WorkflowStateRecord {
  id: string;
  name: string;
  type: string; // backlog | unstarted | started | completed | cancelled
  teamId: string;
  color: string;
  position: number;
}

export interface LabelRecord {
  id: string;
  name: string;
  color: string;
  parentId?: string;
}

export interface CycleRecord {
  id: string;
  number: number;
  name?: string;
  teamId: string;
  startsAt: string;
  endsAt: string;
  completedAt?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  description?: string;
  state: string;
  startDate?: string;
  targetDate?: string;
  teamIds: string[];
  leadId?: string;
}

// ─── Issue & Related Records ───

export interface CommentRecord {
  id: string;
  body: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentRecord {
  id: string;
  title: string;
  url: string;
  sourceType?: string;
  createdAt: string;
}

export interface IssueRelation {
  type: string;
  relatedIssueId: string;
  relatedIssueIdentifier: string;
}

export interface IssueRecord {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  stateId: string;
  stateName: string;
  stateType: string;
  priority: number;
  assigneeId?: string;
  creatorId?: string;
  teamId: string;
  projectId?: string;
  cycleId?: string;
  labelIds: string[];
  parentId?: string;
  parentIdentifier?: string;
  estimate?: number;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  completedAt?: string;
  canceledAt?: string;
  relations: IssueRelation[];
  comments: CommentRecord[];
  attachments: AttachmentRecord[];
}

// ─── GraphQL Response Shapes ───

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface PaginatedResponse<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

export interface ViewerResponse {
  viewer: { id: string; name: string; email: string };
}

export interface TeamsResponse {
  teams: PaginatedResponse<{ id: string; key: string; name: string }>;
}

export interface UsersResponse {
  users: PaginatedResponse<{
    id: string;
    name: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    active: boolean;
  }>;
}

export interface LabelsResponse {
  issueLabels: PaginatedResponse<{
    id: string;
    name: string;
    color: string;
    parent: { id: string } | null;
  }>;
}

export interface TeamStatesResponse {
  team: {
    states: PaginatedResponse<{
      id: string;
      name: string;
      type: string;
      color: string;
      position: number;
    }>;
  };
}

export interface TeamCyclesResponse {
  team: {
    cycles: PaginatedResponse<{
      id: string;
      number: number;
      name: string | null;
      startsAt: string;
      endsAt: string;
      completedAt: string | null;
    }>;
  };
}

export interface ProjectNode {
  id: string;
  name: string;
  slugId: string;
  description: string | null;
  state: string;
  startDate: string | null;
  targetDate: string | null;
  lead: { id: string } | null;
  teams: { nodes: { id: string }[] };
}

export interface ProjectsResponse {
  projects: PaginatedResponse<ProjectNode>;
}

export interface IssueCommentNode {
  id: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  user: { id: string } | null;
}

export interface IssueAttachmentNode {
  id: string;
  title: string;
  url: string;
  sourceType: string | null;
  createdAt: string;
}

export interface IssueRelationNode {
  type: string;
  relatedIssue: { id: string; identifier: string };
}

export interface InverseRelationNode {
  type: string;
  issue: { id: string; identifier: string };
}

export interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  estimate: number | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  completedAt: string | null;
  canceledAt: string | null;
  state: { id: string; name: string; type: string };
  assignee: { id: string } | null;
  creator: { id: string } | null;
  project: { id: string } | null;
  cycle: { id: string } | null;
  parent: { id: string; identifier: string } | null;
  labels: { nodes: { id: string }[] };
  comments: PaginatedResponse<IssueCommentNode>;
  relations: { nodes: IssueRelationNode[] };
  inverseRelations: { nodes: InverseRelationNode[] };
  attachments: { nodes: IssueAttachmentNode[] };
}

export interface TeamIssuesResponse {
  team: {
    issues: PaginatedResponse<IssueNode>;
  };
}

export interface IssueCommentsResponse {
  issue: {
    comments: PaginatedResponse<IssueCommentNode>;
  };
}

// ─── Lookup Maps (built from meta records for fast resolution) ───

export interface LookupMaps {
  teams: Map<string, TeamRecord>;
  users: Map<string, UserRecord>;
  labels: Map<string, LabelRecord>;
  states: Map<string, WorkflowStateRecord>;
  cycles: Map<string, CycleRecord>;
  projects: Map<string, ProjectRecord>;
}

// ─── Priority mapping ───

export const PRIORITY_LABELS: Record<number, string> = {
  0: "None",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

// ─── Inverse relation type mapping ───

export const INVERSE_RELATION_TYPES: Record<string, string> = {
  blocks: "blocked-by",
  "blocked-by": "blocks",
  duplicate: "duplicate-of",
  "duplicate-of": "duplicate",
  related: "related",
};
