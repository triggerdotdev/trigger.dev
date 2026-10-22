// The env vars each coding agent sets in the shells it runs commands in. Based on std-env's
// `detectAgent` (std-env 4+), which we can't use yet because the CLI is still on std-env 3.
const AGENT_ENV_VARS: Array<[name: string, envVars: string[]]> = [
  ["claude", ["CLAUDECODE", "CLAUDE_CODE"]],
  ["cursor", ["CURSOR_AGENT"]],
  ["codex", ["CODEX_SANDBOX", "CODEX_THREAD_ID"]],
  ["gemini", ["GEMINI_CLI"]],
  ["opencode", ["OPENCODE"]],
  ["auggie", ["AUGMENT_AGENT"]],
  ["goose", ["GOOSE_PROVIDER"]],
  ["replit", ["REPL_ID"]],
];

/**
 * Returns the name of the coding agent running the CLI, or undefined when a person is. Set
 * `AI_AGENT` to turn agent output on for an agent we don't detect.
 */
export function detectAgent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AI_AGENT) {
    return env.AI_AGENT.toLowerCase();
  }

  // Set by the Trigger.dev MCP server when it starts `trigger dev` for an agent
  if (env.TRIGGER_MCP_SERVER === "1") {
    return "trigger-mcp";
  }

  for (const [name, envVars] of AGENT_ENV_VARS) {
    if (envVars.some((envVar) => env[envVar])) {
      return name;
    }
  }

  return undefined;
}

export const isAgent = detectAgent() !== undefined;
