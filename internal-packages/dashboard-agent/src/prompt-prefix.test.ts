import { describe, expect, it } from "vitest";
import {
  describePromptPrefix,
  describePromptPrefixParts,
  PROMPT_CACHE_CONTROL,
  promptCacheAttributes,
} from "./prompt-prefix";
import { DASHBOARD_AGENT_SYSTEM_PROMPT, dashboardAgentToolSchemas } from "./tool-schemas";
import { systemPromptFor, toolSchemasFor } from "./prompt-assembly";
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
  // The head-start step composes its prefix from the shared helpers; the agent run
  // builds the real tool set. Both flag values, both modes, or the cache splits.
  for (const mode of ["assistant", "code"] as const) {
    for (const watchEnabled of [false, true]) {
      it(`matches in ${mode} mode with watches ${watchEnabled ? "on" : "off"}`, () => {
        const ctx = {
          ...SCOPE,
          watchEnabled,
          ...(mode === "code" ? { repoSnapshot: snapshot } : {}),
        };
        const headStart = describePromptPrefix({
          system: systemPromptFor(mode, { watchEnabled }),
          tools: toolSchemasFor(mode, { watchEnabled }),
        });
        const agent = describePromptPrefix({
          system: systemPromptFor(mode, { watchEnabled }),
          tools: buildDashboardAgentTools(ctx),
        });

        expect(Object.keys(toolSchemasFor(mode, { watchEnabled }))).toEqual(
          Object.keys(buildDashboardAgentTools(ctx))
        );
        expect(agent.fingerprint).toBe(headStart.fingerprint);
        expect(agent.chars).toBe(headStart.chars);
      });
    }
  }

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
  assistant: { chars: 78_000, estimatedTokens: 19_500, tools: 25, promptChars: 28_600 },
  code: { chars: 84_000, estimatedTokens: 21_000, tools: 29, promptChars: 30_900 },
} as const;

// Measured with watches on: the biggest prefix a turn can hand the provider.
describe("the prefix stays inside its budget", () => {
  const assistant = describePromptPrefixParts({
    system: systemPromptFor("assistant", { watchEnabled: true }),
    tools: toolSchemasFor("assistant", { watchEnabled: true }),
  });
  const code = describePromptPrefixParts({
    system: systemPromptFor("code", { watchEnabled: true }),
    tools: toolSchemasFor("code", { watchEnabled: true }),
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
