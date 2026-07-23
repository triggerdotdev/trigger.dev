import { appendFileSync } from "node:fs";
import { EOL } from "node:os";

function formatGithubActionsCommandFile(entries: Record<string, string>) {
  const lines = Object.entries(entries).map(([key, value]) => `${key}=${value}`);

  return lines.length > 0 ? `${lines.join(EOL)}${EOL}` : "";
}

export function setGithubActionsOutputAndEnvVars({
  envVars,
  outputs,
}: {
  envVars: Record<string, string>;
  outputs: Record<string, string>;
}) {
  // Set environment variables
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, formatGithubActionsCommandFile(envVars));
  }

  // Set outputs
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, formatGithubActionsCommandFile(outputs));
  }
}
