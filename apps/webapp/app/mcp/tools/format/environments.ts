import { GitMeta } from "@trigger.dev/core/v3";
import { fenceUntrusted } from "../../gate/fence.server";
import { capText } from "./logFields";
import { quoteForPreview } from "./webhooks";

const STORED_CHARS = 200;
const SHORT_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION = /^[0-9]{1,16}(\.[0-9]{1,8}){0,3}$/;

export const previewQuote = (value: string) => quoteForPreview(capText(value, STORED_CHARS));
export const agentFence = (value: string, source: string) =>
  fenceUntrusted(capText(value, STORED_CHARS), source);

export type DeploymentFacts = {
  version: string;
  shortCode: string;
  git: unknown;
};

const plainOr = (value: string, pattern: RegExp, render: (v: string) => string) =>
  pattern.test(value) ? value : render(value);

export function describeDeploymentForPreview(deployment: DeploymentFacts): string {
  const version = plainOr(deployment.version, VERSION, previewQuote);
  const shortCode = plainOr(deployment.shortCode, SHORT_CODE, previewQuote);
  const git = GitMeta.safeParse(deployment.git);
  const parts: string[] = [];
  if (git.success && git.data.commitRef)
    parts.push(`git branch ${previewQuote(git.data.commitRef)}`);
  if (git.success && git.data.commitSha) parts.push(`commit ${previewQuote(git.data.commitSha)}`);
  if (git.success && git.data.commitMessage) {
    parts.push(`message ${previewQuote(git.data.commitMessage)}`);
  }
  return `version ${version} (short code ${shortCode}${parts.length ? `, ${parts.join(", ")}` : ""})`;
}

export function describeDeploymentForAgent(deployment: DeploymentFacts): string {
  const version = plainOr(deployment.version, VERSION, (v) => agentFence(v, "deployment-version"));
  const shortCode = plainOr(deployment.shortCode, SHORT_CODE, (v) =>
    agentFence(v, "deployment-short-code")
  );
  return `version ${version} (short code ${shortCode})`;
}

export function environmentLabelForPreview(environment: {
  type: string;
  branchName: string | null;
}): string {
  if (environment.branchName) {
    const kind = environment.type === "DEVELOPMENT" ? "development" : "preview";
    return `${kind} branch ${previewQuote(environment.branchName)}`;
  }
  return ENVIRONMENT_NAMES[environment.type] ?? "this environment";
}

export function environmentLabelForAgent(environment: {
  type: string;
  branchName: string | null;
}): string {
  if (environment.branchName) {
    const kind = environment.type === "DEVELOPMENT" ? "development" : "preview";
    return `${kind} branch ${agentFence(environment.branchName, "branch-name")}`;
  }
  return ENVIRONMENT_NAMES[environment.type] ?? "this environment";
}

const ENVIRONMENT_NAMES: Record<string, string> = {
  PRODUCTION: "the prod environment",
  STAGING: "the staging environment",
  PREVIEW: "the preview environment",
  DEVELOPMENT: "your dev environment",
};
