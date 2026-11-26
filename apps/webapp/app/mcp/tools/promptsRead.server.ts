import type { Prompt, PromptVersion } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { PromptPresenter, type GenerationRow } from "~/presenters/v3/PromptPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { formatModelCost } from "~/utils/modelFormatters";
import { parsePeriodToMs } from "~/utils/periods";
import type { McpToolContext } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, textResult } from "./define.server";
import {
  fenced,
  fencedJson,
  isoTime,
  MODEL_NAME,
  plainError,
  plainOr,
  plural,
} from "./format/insights";
import { subjectEnvironment } from "./query.server";
import { NONE_FOUND, READ_BUDGET_MS, startReadBudget, stoppedText } from "./readBudget.server";
import { GetPromptInput, ListGenerationsInput } from "./schemas/prompts";

const TEMPLATE_CHARS = 32_000;
const JSON_CHARS = 8_000;
const CURSOR = /^[A-Za-z0-9+/]{1,1024}={0,2}$/;
const RUN_ID = /^run_[A-Za-z0-9]{1,64}$/;
const LABEL = /^[a-z0-9_-]{1,64}$/;
const HEX = /^[0-9a-f]{1,128}$/;
const CLICKHOUSE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const auth = { action: "read", subject: "prompts" } as const;

type Reader = <T>(
  start: () => Promise<T>
) => Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" | "aborted" }>;

const direct: Reader = (start) => start().then((value) => ({ ok: true as const, value }));

async function findPrompt(ctx: McpToolContext, slug: string, read: Reader = direct) {
  const found = await read(() => subjectEnvironment(ctx));
  if (!found.ok) return { error: stoppedText(found) };
  const environment = found.value;
  if (!environment) return { error: "Environment not found" };
  const lookup = await read(() =>
    $replica.prompt.findFirst({
      where: { projectId: environment.projectId, runtimeEnvironmentId: environment.id, slug },
    })
  );
  if (!lookup.ok) return { error: stoppedText(lookup) };
  const prompt = lookup.value;
  return prompt
    ? { environment, prompt }
    : { error: `Prompt ${fenced(slug, "prompt-slug")} not found; list_prompts lists the prompts.` };
}

const labels = (values: string[]) =>
  values.length > 0 ? values.map((l) => plainOr(l, LABEL, "prompt-label")).join(", ") : "none";

function resolvedBy(input: { label?: string; version?: number }, version: PromptVersion) {
  if (input.version !== undefined) return `version ${input.version}`;
  if (version.labels.includes("override")) {
    return "the active dashboard override, which wins over any label";
  }
  return `label ${input.label === undefined ? "current" : fenced(input.label, "prompt-label")}`;
}

function formatVersion(version: PromptVersion, by: string): string[] {
  const content =
    version.textContent ??
    (version.chatContent === null ? null : JSON.stringify(version.chatContent));
  const lines = [
    `### Version ${version.version} (resolved by ${by})`,
    `Labels: ${labels(version.labels)}; source: ${plainOr(version.source, /^[a-z]{1,32}$/, "prompt-source")}; created ${isoTime(version.createdAt)}; content hash: ${plainOr(version.contentHash, HEX, "prompt-hash")}`,
  ];
  if (version.model) lines.push(`Model: ${plainOr(version.model, MODEL_NAME, "prompt-model")}`);
  if (version.config !== null) {
    lines.push(`Config: ${fencedJson(version.config, "prompt-config", JSON_CHARS)}`);
  }
  if (version.commitMessage) {
    lines.push(`Commit message: ${fenced(version.commitMessage, "prompt-commit-message", 1_000)}`);
  }
  lines.push(
    content === null
      ? "No content."
      : `Template: ${fenced(content, "prompt-template", TEMPLATE_CHARS)}`
  );
  return lines;
}

function formatPrompt(
  prompt: Prompt,
  counts: { total: number; current?: number; override?: number }
): string[] {
  const lines = [
    `## Prompt ${fenced(prompt.slug, "prompt-slug")} (id: ${plainOr(prompt.friendlyId, /^prompt_[A-Za-z0-9]{1,64}$/, "prompt-id")})`,
    "",
    prompt.description
      ? fenced(prompt.description, "prompt-description", 2_000)
      : "No description.",
    `Type: ${plainOr(prompt.type, /^[a-z]{1,16}$/, "prompt-type")}; tags: ${
      prompt.tags.length > 0 ? fenced(prompt.tags.join(", "), "prompt-tags", 1_000) : "none"
    }`,
    `Versions: ${counts.total}; current: ${counts.current ? `v${counts.current}` : "none"}; active override: ${counts.override ? `v${counts.override}` : "none"}`,
  ];
  if (prompt.archivedAt) lines.push(`Archived ${isoTime(prompt.archivedAt)}.`);
  if (prompt.defaultModel) {
    lines.push(`Default model: ${plainOr(prompt.defaultModel, MODEL_NAME, "prompt-model")}`);
  }
  if (prompt.defaultConfig !== null) {
    lines.push(`Default config: ${fencedJson(prompt.defaultConfig, "prompt-config", JSON_CHARS)}`);
  }
  if (prompt.variableSchema !== null) {
    lines.push(`Variables: ${fencedJson(prompt.variableSchema, "prompt-variables", JSON_CHARS)}`);
  }
  if (prompt.filePath) {
    lines.push(
      `Defined in ${fenced(prompt.filePath, "prompt-file")}${prompt.exportName ? ` as ${fenced(prompt.exportName, "prompt-export")}` : ""}`
    );
  }
  return lines;
}

function generationLine(row: GenerationRow): string {
  const start = CLICKHOUSE_TIME.test(row.start_time)
    ? `${row.start_time.replace(" ", "T")}Z`
    : fenced(row.start_time, "generation-time");
  return [
    `- ${start}`,
    `run ${plainOr(row.run_id, RUN_ID, "generation-run")}`,
    `span ${plainOr(row.span_id, HEX, "generation-span")}`,
    `task ${fenced(row.task_identifier, "generation-task")}`,
    `model ${plainOr(row.response_model, MODEL_NAME, "generation-model")}`,
    `v${row.prompt_version}`,
    `operation ${fenced(row.operation_id, "generation-operation")}`,
    `${row.input_tokens} input and ${row.output_tokens} output tokens`,
    formatModelCost(row.total_cost),
    `${row.duration_ms}ms`,
  ].join(" · ");
}

export function createPromptsReadTools({
  budgetMs = READ_BUDGET_MS,
}: { budgetMs?: number } = {}): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "get_prompt",
      title: "Get Prompt",
      description:
        'Get a prompt\'s details (description, type, tags, default model and config, variables, source file, version counts) and resolve one version with its full template. By default it resolves the "current" label; pass a label or a version number to resolve another. An active dashboard override always wins over a label, as it does when your code resolves the prompt.',
      shape: GetPromptInput.shape,
      auth,
      run: async (input, ctx) => {
        const found = await findPrompt(ctx, input.slug);
        if (!found.prompt) return plainError(found.error);
        const { prompt } = found;

        const [total, labelled, version] = await Promise.all([
          $replica.promptVersion.count({ where: { promptId: prompt.id } }),
          $replica.promptVersion.findMany({
            where: { promptId: prompt.id, labels: { hasSome: ["current", "override"] } },
            select: { version: true, labels: true },
          }),
          new PromptPresenter(undefined as never, $replica).resolveVersion(prompt.id, {
            version: input.version,
            label: input.label,
          }),
        ]);
        const counts = {
          total,
          current: labelled.find((v) => v.labels.includes("current"))?.version,
          override: labelled.find((v) => v.labels.includes("override"))?.version,
        };

        const lines = formatPrompt(prompt, counts);
        lines.push("");
        if (version) {
          lines.push(...formatVersion(version, resolvedBy(input, version)));
        } else {
          lines.push(
            input.version !== undefined
              ? `Version ${input.version} does not exist.`
              : `No version has the label ${input.label === undefined ? "current" : fenced(input.label, "prompt-label")}.`
          );
        }
        return textResult(lines.join("\n"));
      },
    }),
    defineReadTool({
      name: "list_prompt_generations",
      title: "List Prompt Generations",
      description:
        "List the LLM generations that used a prompt, newest first, as the prompt's Generations tab shows them: time, run, span, task, model, prompt version, operation, tokens, cost and duration. It does not return the generated text; open the run to see that. Returns a cursor when there are more.",
      shape: ListGenerationsInput.shape,
      auth,
      run: async (input, ctx) => {
        const budget = startReadBudget(budgetMs, ctx.signal);
        const found = await findPrompt(ctx, input.slug, budget.read);
        if (!found.prompt) return plainError(found.error);
        const { environment, prompt } = found;

        const endTime = new Date();
        const startTime = new Date(endTime.getTime() - parsePeriodToMs(input.period));
        const clickhouse = await budget.read(() =>
          clickhouseFactory.getClickhouseForOrganization(environment.organizationId, "standard")
        );
        if (!clickhouse.ok) return plainError(stoppedText(clickhouse));
        const result = await budget.read(() =>
          new PromptPresenter(clickhouse.value, $replica).listGenerations({
            environmentId: environment.id,
            promptSlug: prompt.slug,
            promptVersions: input.versions,
            startTime,
            endTime,
            cursor: input.cursor,
            pageSize: input.limit,
            limit: budget.limit(),
          })
        );
        if (!result.ok) return plainError(stoppedText(result));

        const { generations, pagination } = result.value;
        const window = `from ${isoTime(startTime)} to ${isoTime(endTime)}`;
        if (generations.length === 0) {
          return textResult(`Generations ${window}: ${NONE_FOUND}`);
        }

        const lines = [
          `## ${plural(generations.length, "generation")} of ${fenced(prompt.slug, "prompt-slug")}, newest first (${window}, times in UTC)`,
          "",
          ...generations.map(generationLine),
        ];
        if (pagination.next) {
          lines.push(
            "",
            CURSOR.test(pagination.next)
              ? `More generations: call again with cursor ${pagination.next}`
              : "More generations exist, but this page cannot be continued; use a shorter period."
          );
        }
        return textResult(lines.join("\n"));
      },
    }),
  ];
}

export const promptsReadTools: McpToolDefinition[] = createPromptsReadTools();
