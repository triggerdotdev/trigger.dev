import { appendFileSync } from "node:fs";

export function setGithubActionsOutputAndEnvVars({
  envVars,
  outputs,
}: {
  envVars: Record<string, string>;
  outputs: Record<string, string>;
}) {
  // Set environment variables
  if (process.env.GITHUB_ENV) {
    const contents = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    appendFileSync(process.env.GITHUB_ENV, contents);
  }

  // Set outputs
  if (process.env.GITHUB_OUTPUT) {
    const contents = Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    appendFileSync(process.env.GITHUB_OUTPUT, contents);
  }
}
