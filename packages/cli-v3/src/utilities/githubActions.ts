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
    const entries = Object.entries(envVars);
    if (entries.length > 0) {
      const contents = `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;

      appendFileSync(process.env.GITHUB_ENV, contents);
    }
  }

  // Set outputs
  if (process.env.GITHUB_OUTPUT) {
    const entries = Object.entries(outputs);
    if (entries.length > 0) {
      const contents = `${entries.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;

      appendFileSync(process.env.GITHUB_OUTPUT, contents);
    }
  }
}
