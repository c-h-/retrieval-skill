/** GraphQL query strings for the Linear API. */

export const VIEWER_QUERY = /* GraphQL */ `
  query Viewer {
    viewer {
      id
      name
      email
    }
  }
`;

export const TEAMS_QUERY = /* GraphQL */ `
  query Teams($after: String) {
    teams(first: 50, after: $after) {
      nodes {
        id
        key
        name
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const USERS_QUERY = /* GraphQL */ `
  query Users($after: String) {
    users(first: 50, after: $after) {
      nodes {
        id
        name
        email
        displayName
        avatarUrl
        active
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const LABELS_QUERY = /* GraphQL */ `
  query Labels($after: String) {
    issueLabels(first: 50, after: $after) {
      nodes {
        id
        name
        color
        parent {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const WORKFLOW_STATES_QUERY = /* GraphQL */ `
  query WorkflowStates($teamId: String!, $after: String) {
    team(id: $teamId) {
      states(first: 50, after: $after) {
        nodes {
          id
          name
          type
          color
          position
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const CYCLES_QUERY = /* GraphQL */ `
  query Cycles($teamId: String!, $after: String) {
    team(id: $teamId) {
      cycles(first: 50, after: $after) {
        nodes {
          id
          number
          name
          startsAt
          endsAt
          completedAt
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const PROJECTS_QUERY = /* GraphQL */ `
  query Projects($after: String) {
    projects(first: 50, after: $after) {
      nodes {
        id
        name
        slugId
        description
        state
        startDate
        targetDate
        lead {
          id
        }
        teams {
          nodes {
            id
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** Issue fields fragment used by both full and incremental queries. */
const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  priority
  estimate
  dueDate
  createdAt
  updatedAt
  archivedAt
  completedAt
  canceledAt
  state {
    id
    name
    type
  }
  assignee {
    id
  }
  creator {
    id
  }
  project {
    id
  }
  cycle {
    id
  }
  parent {
    id
    identifier
  }
  labels {
    nodes {
      id
    }
  }
  comments(first: 100) {
    nodes {
      id
      body
      createdAt
      updatedAt
      user {
        id
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
  relations {
    nodes {
      type
      relatedIssue {
        id
        identifier
      }
    }
  }
  inverseRelations {
    nodes {
      type
      issue {
        id
        identifier
      }
    }
  }
  attachments {
    nodes {
      id
      title
      url
      sourceType
      createdAt
    }
  }
`;

export const TEAM_ISSUES_QUERY = /* GraphQL */ `
  query TeamIssues($teamId: String!, $after: String) {
    team(id: $teamId) {
      issues(
        first: 20
        after: $after
        orderBy: updatedAt
        includeArchived: true
      ) {
        nodes {
          ${ISSUE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const TEAM_ISSUES_INCREMENTAL_QUERY = /* GraphQL */ `
  query UpdatedTeamIssues($teamId: String!, $since: DateTimeOrDuration!, $after: String) {
    team(id: $teamId) {
      issues(
        first: 20
        after: $after
        filter: { updatedAt: { gt: $since } }
        orderBy: updatedAt
        includeArchived: true
      ) {
        nodes {
          ${ISSUE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const ISSUE_COMMENTS_QUERY = /* GraphQL */ `
  query IssueComments($issueId: String!, $after: String) {
    issue(id: $issueId) {
      comments(first: 100, after: $after) {
        nodes {
          id
          body
          createdAt
          updatedAt
          user {
            id
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;
