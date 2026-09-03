import { describe, expect, it } from "vitest";
import {
  describePromptPrefix,
  describePromptPrefixParts,
  PROMPT_CACHE_CONTROL,
  promptCacheAttributes,
} from "./prompt-prefix";
import {
  DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  dashboardAgentCodeToolSchemas,
  dashboardAgentToolSchemas,
} from "./tool-schemas";
import { buildDashboardAgentTools } from "./tools";
import type { RepoSnapshot } from "./repo-tools";

const SCOPE = { projectRef: "proj_abc", environmentId: "env_abc" };

const snapshot: RepoSnapshot = {
  tarballUrl: "http://unused.invalid/never-fetched",
  owner: "acme",
  repo: "demo",
  sha: "deadbeefdeadbeef",
};

/**
 * The whole point of the frozen tool key order: the webapp's warm first call and the
 * agent task's every-later call must hand Anthropic a byte-identical prefix, or they
 * cache separately and every call pays a fresh write.
 */
describe("the head-start and agent prefixes are the same prefix", () => {
  it("matches in assistant mode", () => {
    const headStart = describePromptPrefix({
      system: DASHBOARD_AGENT_SYSTEM_PROMPT,
      tools: dashboardAgentToolSchemas,
    });
    const agent = describePromptPrefix({
      system: DASHBOARD_AGENT_SYSTEM_PROMPT,
      tools: buildDashboardAgentTools(SCOPE),
    });

    expect(agent.fingerprint).toBe(headStart.fingerprint);
    expect(agent.chars).toBe(headStart.chars);
  });

  it("matches in code mode", () => {
    const headStart = describePromptPrefix({
      system: DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
      tools: dashboardAgentCodeToolSchemas,
    });
    const agent = describePromptPrefix({
      system: DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
      tools: buildDashboardAgentTools({ ...SCOPE, repoSnapshot: snapshot }),
    });

    expect(agent.fingerprint).toBe(headStart.fingerprint);
  });

  it("notices a reordered or changed tool set", () => {
    const base = describePromptPrefix({
      system: DASHBOARD_AGENT_SYSTEM_PROMPT,
      tools: dashboardAgentToolSchemas,
    });

    const { list_projects, ...rest } = dashboardAgentToolSchemas;
    const reordered = describePromptPrefix({
      system: DASHBOARD_AGENT_SYSTEM_PROMPT,
      tools: { ...rest, list_projects },
    });
    expect(reordered.fingerprint).not.toBe(base.fingerprint);

    const editedPrompt = describePromptPrefix({
      system: `${DASHBOARD_AGENT_SYSTEM_PROMPT}\nOne more rule.`,
      tools: dashboardAgentToolSchemas,
    });
    expect(editedPrompt.fingerprint).not.toBe(base.fingerprint);
  });

  it("caches on the 1-hour breakpoint", () => {
    expect(PROMPT_CACHE_CONTROL).toEqual({ type: "ephemeral", ttl: "1h" });
  });
});

/**
 * The prefix is paid on every call of every chat, so it gets a ceiling rather than a
 * comment. Growing past one of these is allowed — but the PR that grows it moves the
 * ceiling in the same change, which is what makes the cost a decision instead of a
 * drift. The snapshot below is the itemised diff a reviewer reads.
 */
const PREFIX_BUDGET = {
  assistant: { chars: 79_400, estimatedTokens: 20_100, tools: 25, promptChars: 27_500 },
  code: { chars: 87_000, estimatedTokens: 22_000, tools: 29, promptChars: 30_100 },
} as const;

describe("the prefix stays inside its budget", () => {
  const assistant = describePromptPrefixParts({
    system: DASHBOARD_AGENT_SYSTEM_PROMPT,
    tools: dashboardAgentToolSchemas,
  });
  const code = describePromptPrefixParts({
    system: DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
    tools: dashboardAgentCodeToolSchemas,
  });

  it("holds the assistant-mode ceilings", () => {
    expect(assistant.total.chars).toBeLessThanOrEqual(PREFIX_BUDGET.assistant.chars);
    expect(assistant.total.estimatedTokens).toBeLessThanOrEqual(
      PREFIX_BUDGET.assistant.estimatedTokens
    );
    expect(assistant.tools.count).toBeLessThanOrEqual(PREFIX_BUDGET.assistant.tools);
    expect(assistant.prompt.chars).toBeLessThanOrEqual(PREFIX_BUDGET.assistant.promptChars);
  });

  it("holds the code-mode ceilings", () => {
    expect(code.total.chars).toBeLessThanOrEqual(PREFIX_BUDGET.code.chars);
    expect(code.total.estimatedTokens).toBeLessThanOrEqual(PREFIX_BUDGET.code.estimatedTokens);
    expect(code.tools.count).toBeLessThanOrEqual(PREFIX_BUDGET.code.tools);
    expect(code.prompt.chars).toBeLessThanOrEqual(PREFIX_BUDGET.code.promptChars);
  });

  // The committed numbers themselves, in `__snapshots__/prompt-prefix.test.ts.snap`.
  // A prompt edit or a new tool shows up here as a diff; `vitest -u` accepts it.
  it("matches the committed measurement", () => {
    expect({ assistant, code }).toMatchSnapshot();
  });
});

describe("promptCacheAttributes", () => {
  const prefix = { chars: 80_000, estimatedTokens: 20_000, fingerprint: "abcd1234" };

  it("records the four token counts the provider reports", () => {
    expect(
      promptCacheAttributes({
        source: "agent-turn",
        usage: {
          inputTokens: 21_000,
          inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 20_900, cacheWriteTokens: 0 },
        },
        prefix,
      })
    ).toEqual({
      "dashboard_agent.prompt_cache.source": "agent-turn",
      "gen_ai.usage.input_tokens": 21_000,
      "gen_ai.usage.cache_write_input_tokens": 0,
      "gen_ai.usage.cache_read_input_tokens": 20_900,
      "gen_ai.usage.uncached_input_tokens": 100,
      "dashboard_agent.prefix.estimated_tokens": 20_000,
      "dashboard_agent.prefix.chars": 80_000,
      "dashboard_agent.prefix.fingerprint": "abcd1234",
    });
  });

  it("reports a value the provider didn't give as null rather than zero", () => {
    const attributes = promptCacheAttributes({ source: "head-start", usage: undefined, prefix });
    expect(attributes["gen_ai.usage.cache_write_input_tokens"]).toBeNull();
    expect(attributes["gen_ai.usage.cache_read_input_tokens"]).toBeNull();
    expect(attributes["gen_ai.usage.uncached_input_tokens"]).toBeNull();
    expect(attributes["gen_ai.usage.input_tokens"]).toBeNull();
    // Ours, so always present.
    expect(attributes["dashboard_agent.prefix.estimated_tokens"]).toBe(20_000);
  });
});
