import { z } from "zod";

export const WebhookRepoSourceSchema = z.object({
  subresource: z.literal("repository"),
  scopes: z.array(z.string()),
  repo: z.string(),
  events: z.array(z.string()),
});

export const WebhookOrganizationSourceSchema = z.object({
  subresource: z.literal("organization"),
  scopes: z.array(z.string()),
  org: z.string(),
  events: z.array(z.string()),
});

export const WebhookSourceSchema = z.union([
  WebhookRepoSourceSchema,
  WebhookOrganizationSourceSchema,
]);

const ReactionsSchema = z.object({
  "+1": z.number().int(),
  "-1": z.number().int(),
  url: z.string().url(),
  eyes: z.number().int(),
  heart: z.number().int(),
  laugh: z.number().int(),
  hooray: z.number().int(),
  rocket: z.number().int(),
  confused: z.number().int(),
  total_count: z.number().int(),
});

const UserSchema = z.object({
  id: z.number().int(),
  url: z.string().url(),
  type: z.string(),
  login: z.string(),
  node_id: z.string(),
  html_url: z.string().url(),
  gists_url: z.string().url(),
  repos_url: z.string().url(),
  avatar_url: z.string().url(),
  events_url: z.string().url(),
  site_admin: z.boolean(),
  gravatar_id: z.string(),
  starred_url: z.string().url(),
  followers_url: z.string().url(),
  following_url: z.string().url(),
  organizations_url: z.string().url(),
  subscriptions_url: z.string().url(),
  received_events_url: z.string().url(),
});

const RepositorySchema = z.object({
  id: z.number().int(),
  url: z.string().url(),
  fork: z.boolean(),
  name: z.string(),
  size: z.number().int(),
  forks: z.number().int(),
  owner: UserSchema,
  topics: z.array(z.string()),
  git_url: z.string().url(),
  license: z.object({
    key: z.string(),
    url: z.string().url(),
    name: z.string(),
    node_id: z.string(),
    spdx_id: z.string(),
  }),
  node_id: z.string(),
  private: z.boolean(),
  ssh_url: z.string(),
  svn_url: z.string().url(),
  archived: z.boolean(),
  disabled: z.boolean(),
  has_wiki: z.boolean(),
  homepage: z.string().url(),
  html_url: z.string().url(),
  keys_url: z.string().url(),
  language: z.string(),
  tags_url: z.string().url(),
  watchers: z.number().int(),
  blobs_url: z.string().url(),
  clone_url: z.string().url(),
  forks_url: z.string().url(),
  full_name: z.string(),
  has_pages: z.boolean(),
  hooks_url: z.string().url(),
  pulls_url: z.string().url(),
  pushed_at: z.string(),
  teams_url: z.string().url(),
  trees_url: z.string().url(),
  created_at: z.string(),
  events_url: z.string().url(),
  has_issues: z.boolean(),
  issues_url: z.string().url(),
  labels_url: z.string().url(),
  merges_url: z.string().url(),
  mirror_url: z.null(),
  updated_at: z.string(),
  visibility: z.string(),
  archive_url: z.string().url(),
  commits_url: z.string().url(),
  compare_url: z.string().url(),
  description: z.string(),
  forks_count: z.number().int(),
  is_template: z.boolean(),
  open_issues: z.number().int(),
  branches_url: z.string().url(),
  comments_url: z.string().url(),
  contents_url: z.string().url(),
  git_refs_url: z.string().url(),
  git_tags_url: z.string().url(),
  has_projects: z.boolean(),
  releases_url: z.string().url(),
  statuses_url: z.string().url(),
  allow_forking: z.boolean(),
  assignees_url: z.string().url(),
  downloads_url: z.string().url(),
  has_downloads: z.boolean(),
  languages_url: z.string().url(),
  default_branch: z.string(),
  milestones_url: z.string().url(),
  stargazers_url: z.string().url(),
  watchers_count: z.number().int(),
  deployments_url: z.string().url(),
  git_commits_url: z.string().url(),
  has_discussions: z.boolean(),
  subscribers_url: z.string().url(),
  contributors_url: z.string().url(),
  issue_events_url: z.string().url(),
  stargazers_count: z.number().int(),
  subscription_url: z.string().url(),
  collaborators_url: z.string().url(),
  issue_comment_url: z.string().url(),
  notifications_url: z.string().url(),
  open_issues_count: z.number().int(),
  web_commit_signoff_required: z.boolean(),
});

const IssueSchema = z.object({
  id: z.number().int(),
  url: z.string().url(),
  body: z.string(),
  user: UserSchema,
  state: z.string(),
  title: z.string(),
  labels: z.array(z.any()),
  locked: z.boolean(),
  number: z.number().int(),
  node_id: z.string(),
  assignee: UserSchema.optional(),
  comments: z.number().int(),
  html_url: z.string().url(),
  assignees: z.array(UserSchema),
  closed_at: z.null(),
  milestone: z.null(),
  reactions: ReactionsSchema,
  created_at: z.string(),
  events_url: z.string().url(),
  labels_url: z.string().url(),
  updated_at: z.string(),
  comments_url: z.string().url(),
  state_reason: z.null(),
  timeline_url: z.string().url(),
  repository_url: z.string().url(),
  active_lock_reason: z.null(),
  author_association: z.string(),
  performed_via_github_app: z.null(),
});

const LabelSchema = z.object({
  id: z.number().int(),
  url: z.string().url(),
  name: z.string(),
  color: z.string(),
  default: z.boolean(),
  node_id: z.string(),
  description: z.string(),
});

const OrganizationSchema = z.object({
  id: z.number().int(),
  url: z.string().url(),
  login: z.string(),
  node_id: z.string(),
  hooks_url: z.string().url(),
  repos_url: z.string().url(),
  avatar_url: z.string().url(),
  events_url: z.string().url(),
  issues_url: z.string().url(),
  description: z.string(),
  members_url: z.string().url(),
  public_members_url: z.string().url(),
});

const SharedIssueEventSchema = z.object({
  issue: IssueSchema,
  sender: UserSchema,
  repository: RepositorySchema,
  organization: OrganizationSchema,
});

const LabeledIssueEventSchema = z
  .object({
    action: z.literal("labeled"),
    label: LabelSchema,
  })
  .merge(SharedIssueEventSchema);

const UnlabeledIssueEventSchema = z
  .object({
    action: z.literal("unlabeled"),
    label: LabelSchema,
  })
  .merge(SharedIssueEventSchema);

const AssignedIssueEventSchema = z
  .object({
    action: z.literal("assigned"),
    assignee: UserSchema,
  })
  .merge(SharedIssueEventSchema);

const UnassignedIssueEventSchema = z
  .object({
    action: z.literal("unassigned"),
    assignee: UserSchema,
  })
  .merge(SharedIssueEventSchema);

export const IssueEventSchema = z.discriminatedUnion("action", [
  LabeledIssueEventSchema,
  UnlabeledIssueEventSchema,
  AssignedIssueEventSchema,
  UnassignedIssueEventSchema,
]);
