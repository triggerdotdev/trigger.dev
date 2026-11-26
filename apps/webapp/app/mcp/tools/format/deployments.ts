import type { AgentActivity } from "~/presenters/v3/AgentDetailPresenter.server";
import type { DeploymentPresenter } from "~/presenters/v3/DeploymentPresenter.server";
import type { TaskDetail } from "~/presenters/v3/TaskDetailPresenter.server";
import { plainError } from "./insights";
import { untrusted } from "./logFields";

type Deployment = NonNullable<Awaited<ReturnType<DeploymentPresenter["call"]>>>["deployment"];
type AgentDetail = Pick<TaskDetail, "slug" | "filePath" | "createdAt" | "config">;

const VALUE_CHARS = 512;
const ERROR_CHARS = 8_000;
const CONFIG_CHARS = 8_000;
const MAX_TASKS = 200;

const SHORT_CODE = /^[0-9A-Za-z_-]{1,32}$/;
const VERSION = /^\d{8}\.\d{1,6}$/;
const STATUS = /^[A-Z_]{1,32}$/;
const ID = /^[0-9A-Za-z_-]{1,128}$/;

const plainOr = (value: string, pattern: RegExp, source: string) =>
  pattern.test(value) ? value : untrusted(value, source, VALUE_CHARS);

export const deploymentNotFound = (id: string) =>
  plainError(
    `Deployment ${plainOr(id, ID, "deployment-id")} was not found in this environment. Use list_deploys to see the deployments in this environment.`
  );

export const agentNotFound = (slug: string) =>
  plainError(
    `Agent ${plainOr(slug, ID, "agent-slug")} was not found in this environment. Use list_agents to see the agents in this environment.`
  );

const time = (date: Date | null | undefined) => (date ? date.toISOString() : "–");

const field = (value: string | number | null | undefined, source: string) =>
  value === null || value === undefined || value === ""
    ? undefined
    : untrusted(String(value), source, VALUE_CHARS);

/** "label: value" lines, skipping the labels whose value is undefined. */
const labelled = (pairs: Array<[string, string | undefined]>) =>
  pairs.flatMap(([label, value]) => (value === undefined ? [] : [`${label}: ${value}`]));

function gitLines(git: Deployment["git"]): string[] {
  if (!git) return [];
  return labelled([
    ["Git repository", field(git.repositoryUrl, "deploy-git")],
    ["Git branch", field(git.branchName, "deploy-git")],
    ["Git commit", field(git.shortSha, "deploy-git")],
    ["Git commit message", field(git.commitMessage, "deploy-git")],
    ["Git commit author", field(git.commitAuthor, "deploy-git")],
    ["Git dirty", git.isDirty ? "yes" : undefined],
    [
      "Pull request",
      git.pullRequestNumber
        ? `#${git.pullRequestNumber}${
            git.pullRequestTitle ? ` ${field(git.pullRequestTitle, "deploy-git")}` : ""
          }`
        : undefined,
    ],
  ]);
}

function errorLines(errorData: Deployment["errorData"]): string[] {
  if (!errorData) return [];
  const { name, message, stack, stderr } = errorData;
  return [
    "",
    "Error:",
    untrusted(`${name}: ${message}`, "deploy-error", ERROR_CHARS),
    ...(stack ? ["Stack:", untrusted(stack, "deploy-error-stack", ERROR_CHARS)] : []),
    ...(stderr ? ["Stderr:", untrusted(stderr, "deploy-error-stderr", ERROR_CHARS)] : []),
  ];
}

function taskLines(tasks: NonNullable<Deployment["tasks"]>): string[] {
  if (tasks.length === 0) return [];
  return [
    "",
    "Tasks (slug, file):",
    ...tasks
      .slice(0, MAX_TASKS)
      .map(
        (task) =>
          `- ${untrusted(task.slug, "deploy-task", VALUE_CHARS)} ${untrusted(
            task.filePath,
            "deploy-task-file",
            VALUE_CHARS
          )}`
      ),
    ...(tasks.length > MAX_TASKS
      ? [
          `… ${tasks.length - MAX_TASKS} more tasks not shown. Use get_current_worker for the current version's full task list.`,
        ]
      : []),
  ];
}

export function formatDeploymentDetails(deployment: Deployment): string {
  const git = deployment.git;
  const deployedBy =
    git?.source === "trigger_github_app"
      ? (git.ghUsername ?? "GitHub Integration")
      : (deployment.deployedBy?.name ?? deployment.deployedBy?.displayName);

  return [
    `Deployment ${plainOr(deployment.shortCode, SHORT_CODE, "deploy-short-code")}`,
    ...labelled([
      ["Label", field(deployment.label, "deploy-label")],
      ["Environment", plainOr(deployment.environment.type, STATUS, "deploy-environment")],
      ["Version", plainOr(deployment.version, VERSION, "deploy-version")],
      [
        "Redeploy of",
        deployment.redeployOf
          ? plainOr(deployment.redeployOf, SHORT_CODE, "deploy-redeploy-of")
          : undefined,
      ],
      ["Status", plainOr(deployment.status, STATUS, "deploy-status")],
      [
        "Superseded by",
        deployment.supersededBy
          ? `${plainOr(deployment.supersededBy.shortCode, SHORT_CODE, "deploy-short-code")} (v${plainOr(
              deployment.supersededBy.version,
              VERSION,
              "deploy-version"
            )})`
          : undefined,
      ],
      ["Canceled at", deployment.canceledAt ? time(deployment.canceledAt) : undefined],
      [
        "Cancelation reason",
        deployment.supersededBy
          ? undefined
          : field(deployment.canceledReason, "deploy-cancel-reason"),
      ],
      ["Tasks", deployment.tasks ? String(deployment.tasks.length) : "–"],
      ["SDK version", field(deployment.sdkVersion, "deploy-sdk-version") ?? "–"],
      ["CLI version", field(deployment.cliVersion, "deploy-cli-version") ?? "–"],
      [
        "Runtime",
        field(
          [deployment.runtime, deployment.runtimeVersion].filter(Boolean).join(" "),
          "deploy-runtime"
        ) ?? "–",
      ],
      ["Worker type", plainOr(deployment.type, STATUS, "deploy-type")],
      ["External ID", field(deployment.externalId, "deploy-external-id")],
      ["Created at", time(deployment.createdAt)],
      ["Started at", time(deployment.startedAt)],
      ["Installed at", time(deployment.installedAt)],
      ["Built at", time(deployment.builtAt)],
      ["Deployed at", time(deployment.deployedAt)],
    ]),
    ...gitLines(git),
    ...labelled([
      ["Deployed by", field(deployedBy, "deploy-user") ?? "–"],
      ["Triggered via", field(deployment.triggeredVia, "deploy-triggered-via")],
      ["Linked Vercel deployment", field(deployment.vercelDeploymentUrl, "deploy-vercel")],
    ]),
    ...errorLines(deployment.errorData),
    ...taskLines(deployment.tasks ?? []),
  ].join("\n");
}

/** An activity section is undefined when the caller lacks the right to see it. */
type AgentActivityTotals = {
  runs?: AgentActivity;
  sessions?: AgentActivity;
  cost?: AgentActivity;
  tokens?: AgentActivity;
};

const requires = (scope: string) => `not shown, this needs ${scope}`;

function totals(activity: AgentActivity): string {
  if (activity.statuses.length === 0) return "unavailable (the activity read failed)";
  return activity.statuses
    .map((status) => {
      const sum = activity.data.reduce((total, point) => total + (point[status] ?? 0), 0);
      return `${status} ${sum}`;
    })
    .join(", ");
}

function sumOf(activity: AgentActivity, key: string): number | undefined {
  if (activity.statuses.length === 0) return undefined;
  return activity.data.reduce((total, point) => total + (point[key] ?? 0), 0);
}

export function formatAgentDetails(
  agent: AgentDetail,
  period: string,
  activity: AgentActivityTotals
): string {
  const cost = activity.cost && sumOf(activity.cost, "cost");
  const tokens = activity.tokens && sumOf(activity.tokens, "tokens");
  const failed = "unavailable (the activity read failed)";
  const config = agent.config === null || agent.config === undefined ? undefined : agent.config;

  return [
    `Agent ${untrusted(agent.slug, "agent-slug", VALUE_CHARS)}`,
    `File: ${untrusted(agent.filePath, "agent-file", VALUE_CHARS)}`,
    `Created at: ${agent.createdAt.toISOString()}`,
    "",
    `Activity in the last ${period}:`,
    `- Runs by status: ${activity.runs ? totals(activity.runs) : requires("read:runs")}`,
    `- Sessions by status: ${activity.sessions ? totals(activity.sessions) : requires("read:sessions")}`,
    `- LLM cost: ${!activity.cost ? requires("read:query") : cost === undefined ? failed : `$${cost.toFixed(6)}`}`,
    `- LLM tokens: ${!activity.tokens ? requires("read:query") : tokens === undefined ? failed : tokens}`,
    "",
    config === undefined
      ? "Config: none"
      : `Config:\n${untrusted(JSON.stringify(config, null, 2), "agent-config", CONFIG_CHARS)}`,
    "",
    "Use list_runs with this agent's slug as taskIdentifier to see its runs.",
  ].join("\n");
}
