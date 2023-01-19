import { z } from "zod";

export const userSchema = z.object({
  login: z.string(),
  id: z.number(),
  node_id: z.string(),
  name: z.string().optional(),
  email: z.string().optional().nullable(),
  avatar_url: z.string(),
  gravatar_id: z.string(),
  url: z.string(),
  html_url: z.string(),
  followers_url: z.string(),
  following_url: z.string(),
  gists_url: z.string(),
  starred_url: z.string(),
  subscriptions_url: z.string(),
  organizations_url: z.string(),
  repos_url: z.string(),
  events_url: z.string(),
  received_events_url: z.string(),
  type: z.union([
    z.literal("Bot"),
    z.literal("User"),
    z.literal("Organization"),
  ]),
  site_admin: z.boolean(),
});

export const licenseSchema = z.object({
  key: z.string(),
  name: z.string(),
  spdx_id: z.string(),
  url: z.string().nullable(),
  node_id: z.string(),
});

export const installationLiteSchema = z.object({
  id: z.number(),
  node_id: z.string(),
});

export const organizationSchema = z.object({
  login: z.string(),
  id: z.number(),
  node_id: z.string(),
  url: z.string(),
  html_url: z.string().optional(),
  repos_url: z.string(),
  events_url: z.string(),
  hooks_url: z.string(),
  issues_url: z.string(),
  members_url: z.string(),
  public_members_url: z.string(),
  avatar_url: z.string(),
  description: z.string().nullable(),
});

export const repositorySchema = z.object({
  id: z.number(),
  node_id: z.string(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  owner: userSchema,
  html_url: z.string(),
  description: z.string().nullable(),
  fork: z.boolean(),
  url: z.string(),
  forks_url: z.string(),
  keys_url: z.string(),
  collaborators_url: z.string(),
  teams_url: z.string(),
  hooks_url: z.string(),
  issue_events_url: z.string(),
  events_url: z.string(),
  assignees_url: z.string(),
  branches_url: z.string(),
  tags_url: z.string(),
  blobs_url: z.string(),
  git_tags_url: z.string(),
  git_refs_url: z.string(),
  trees_url: z.string(),
  statuses_url: z.string(),
  languages_url: z.string(),
  stargazers_url: z.string(),
  contributors_url: z.string(),
  subscribers_url: z.string(),
  subscription_url: z.string(),
  commits_url: z.string(),
  git_commits_url: z.string(),
  comments_url: z.string(),
  issue_comment_url: z.string(),
  contents_url: z.string(),
  compare_url: z.string(),
  merges_url: z.string(),
  archive_url: z.string(),
  downloads_url: z.string(),
  issues_url: z.string(),
  pulls_url: z.string(),
  milestones_url: z.string(),
  notifications_url: z.string(),
  labels_url: z.string(),
  releases_url: z.string(),
  deployments_url: z.string(),
  created_at: z.union([z.number(), z.string()]),
  updated_at: z.string(),
  pushed_at: z.union([z.number(), z.string()]).nullable(),
  git_url: z.string(),
  ssh_url: z.string(),
  clone_url: z.string(),
  svn_url: z.string(),
  homepage: z.string().nullable(),
  size: z.number(),
  stargazers_count: z.number(),
  watchers_count: z.number(),
  language: z.string().nullable(),
  has_issues: z.boolean(),
  has_projects: z.boolean(),
  has_downloads: z.boolean(),
  has_wiki: z.boolean(),
  has_pages: z.boolean(),
  forks_count: z.number(),
  mirror_url: z.string().nullable(),
  archived: z.boolean(),
  disabled: z.boolean().optional(),
  open_issues_count: z.number(),
  license: licenseSchema.nullable(),
  forks: z.number(),
  open_issues: z.number(),
  watchers: z.number(),
  stargazers: z.number().optional(),
  default_branch: z.string(),
  allow_squash_merge: z.boolean().optional(),
  allow_merge_commit: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
  allow_auto_merge: z.boolean().optional(),
  allow_forking: z.boolean().optional(),
  allow_update_branch: z.boolean().optional(),
  use_squash_pr_title_as_default: z.boolean().optional(),
  squash_merge_commit_message: z.string().optional(),
  squash_merge_commit_title: z.string().optional(),
  merge_commit_message: z.string().optional(),
  merge_commit_title: z.string().optional(),
  is_template: z.boolean(),
  web_commit_signoff_required: z.boolean(),
  topics: z.array(z.string()),
  visibility: z.union([
    z.literal("public"),
    z.literal("private"),
    z.literal("internal"),
  ]),
  delete_branch_on_merge: z.boolean().optional(),
  master_branch: z.string().optional(),
  permissions: z
    .object({
      pull: z.boolean(),
      push: z.boolean(),
      admin: z.boolean(),
      maintain: z.boolean().optional(),
      triage: z.boolean().optional(),
    })
    .optional(),
  public: z.boolean().optional(),
  organization: z.string().optional(),
});

export const teamSchema = z.object({
  name: z.string(),
  id: z.number(),
  node_id: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  privacy: z.union([
    z.literal("open"),
    z.literal("closed"),
    z.literal("secret"),
  ]),
  url: z.string(),
  html_url: z.string(),
  members_url: z.string(),
  repositories_url: z.string(),
  permission: z.string(),
  parent: z
    .object({
      name: z.string(),
      id: z.number(),
      node_id: z.string(),
      slug: z.string(),
      description: z.string().nullable(),
      privacy: z.union([
        z.literal("open"),
        z.literal("closed"),
        z.literal("secret"),
      ]),
      url: z.string(),
      html_url: z.string(),
      members_url: z.string(),
      repositories_url: z.string(),
      permission: z.string(),
    })
    .optional()
    .nullable(),
});

export const linkSchema = z.object({
  href: z.string(),
});

export const appSchema = z.object({
  id: z.number(),
  slug: z.string().optional(),
  node_id: z.string(),
  owner: userSchema,
  name: z.string(),
  description: z.string().nullable(),
  external_url: z.string(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  permissions: z
    .object({
      actions: z.union([z.literal("read"), z.literal("write")]).optional(),
      administration: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      blocking: z.union([z.literal("read"), z.literal("write")]).optional(),
      checks: z.union([z.literal("read"), z.literal("write")]).optional(),
      content_references: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      contents: z.union([z.literal("read"), z.literal("write")]).optional(),
      deployments: z.union([z.literal("read"), z.literal("write")]).optional(),
      discussions: z.union([z.literal("read"), z.literal("write")]).optional(),
      emails: z.union([z.literal("read"), z.literal("write")]).optional(),
      environments: z.union([z.literal("read"), z.literal("write")]).optional(),
      issues: z.union([z.literal("read"), z.literal("write")]).optional(),
      keys: z.union([z.literal("read"), z.literal("write")]).optional(),
      members: z.union([z.literal("read"), z.literal("write")]).optional(),
      merge_queues: z.union([z.literal("read"), z.literal("write")]).optional(),
      metadata: z.union([z.literal("read"), z.literal("write")]).optional(),
      organization_administration: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      organization_hooks: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      organization_packages: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      organization_plan: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      organization_projects: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      organization_secrets: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      organization_self_hosted_runners: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      organization_user_blocking: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      packages: z.union([z.literal("read"), z.literal("write")]).optional(),
      pages: z.union([z.literal("read"), z.literal("write")]).optional(),
      pull_requests: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      repository_hooks: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      repository_projects: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      secret_scanning_alerts: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      secrets: z.union([z.literal("read"), z.literal("write")]).optional(),
      security_events: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      security_scanning_alert: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      single_file: z.union([z.literal("read"), z.literal("write")]).optional(),
      statuses: z.union([z.literal("read"), z.literal("write")]).optional(),
      team_discussions: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      vulnerability_alerts: z
        .union([z.literal("read"), z.literal("write")])
        .optional(),
      workflows: z.union([z.literal("read"), z.literal("write")]).optional(),
    })
    .optional(),
  events: z
    .array(
      z.union([
        z.literal("branch_protection_rule"),
        z.literal("check_run"),
        z.literal("check_suite"),
        z.literal("code_scanning_alert"),
        z.literal("commit_comment"),
        z.literal("content_reference"),
        z.literal("create"),
        z.literal("delete"),
        z.literal("deployment"),
        z.literal("deployment_review"),
        z.literal("deployment_status"),
        z.literal("deploy_key"),
        z.literal("discussion"),
        z.literal("discussion_comment"),
        z.literal("fork"),
        z.literal("gollum"),
        z.literal("issues"),
        z.literal("issue_comment"),
        z.literal("label"),
        z.literal("member"),
        z.literal("membership"),
        z.literal("merge_group"),
        z.literal("merge_queue_entry"),
        z.literal("milestone"),
        z.literal("organization"),
        z.literal("org_block"),
        z.literal("page_build"),
        z.literal("project"),
        z.literal("projects_v2_item"),
        z.literal("project_card"),
        z.literal("project_column"),
        z.literal("public"),
        z.literal("pull_request"),
        z.literal("pull_request_review"),
        z.literal("pull_request_review_comment"),
        z.literal("push"),
        z.literal("registry_package"),
        z.literal("release"),
        z.literal("repository"),
        z.literal("repository_dispatch"),
        z.literal("secret_scanning_alert"),
        z.literal("secret_scanning_alert_location"),
        z.literal("security_and_analysis"),
        z.literal("star"),
        z.literal("status"),
        z.literal("team"),
        z.literal("team_add"),
        z.literal("watch"),
        z.literal("workflow_dispatch"),
        z.literal("workflow_run"),
        z.literal("workflow_job"),
      ])
    )
    .optional(),
});

export const reactionsSchema = z.object({
  url: z.string(),
  total_count: z.number(),
  "+1": z.number(),
  "-1": z.number(),
  laugh: z.number(),
  hooray: z.number(),
  confused: z.number(),
  heart: z.number(),
  rocket: z.number(),
  eyes: z.number(),
});

export const authorAssociationSchema = z.union([
  z.literal("COLLABORATOR"),
  z.literal("CONTRIBUTOR"),
  z.literal("FIRST_TIMER"),
  z.literal("FIRST_TIME_CONTRIBUTOR"),
  z.literal("MANNEQUIN"),
  z.literal("MEMBER"),
  z.literal("NONE"),
  z.literal("OWNER"),
]);

export const milestoneSchema = z.object({
  url: z.string(),
  html_url: z.string(),
  labels_url: z.string(),
  id: z.number(),
  node_id: z.string(),
  number: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  creator: userSchema,
  open_issues: z.number(),
  closed_issues: z.number(),
  state: z.union([z.literal("open"), z.literal("closed")]),
  created_at: z.string(),
  updated_at: z.string(),
  due_on: z.string().nullable(),
  closed_at: z.string().nullable(),
});

export const labelSchema = z.object({
  id: z.number(),
  node_id: z.string(),
  url: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string(),
  default: z.boolean(),
});
