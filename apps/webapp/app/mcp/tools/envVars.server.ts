import { boundedIn, type RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";
import { $replica } from "~/db.server";
import {
  loadEnvironmentVariablesEnvironments,
  type EnvironmentVariablesEnvironment,
} from "~/presenters/v3/environmentVariablesEnvironments.server";
import { notePersonalAccessTokenAuthentication } from "~/services/auditLogs/auditContext.server";
import {
  environmentReadTarget,
  recordEnvironmentVariableRead,
} from "~/services/auditLogs/envVarReadAudit.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, textResult } from "./define.server";
import { plainError } from "./format/insights";
import { untrusted } from "./format/logFields";
import { startReadBudget } from "./readBudget.server";
import { CommonProjectsInput } from "./schemas/common";

const TOOL = "list_environment_variables";
const READ_BUDGET_MS = 10_000;
const LIMIT = 100;
const NAME_CHARS = 256;
const BRANCH_NAME_CHARS = 128;
/** Branches named per variable; the rest are counted. */
const BRANCHES_PER_NAME = 5;
const MAX_CHARS = 60_000;

const TYPE_LABELS: Record<RuntimeEnvironmentType, string> = {
  DEVELOPMENT: "dev",
  STAGING: "staging",
  PRODUCTION: "prod",
  PREVIEW: "preview",
};

const ListEnvironmentVariablesInput = CommonProjectsInput.pick({
  projectRef: true,
  configPath: true,
}).extend({
  offset: z
    .number()
    .int()
    .min(0)
    .max(100_000_000)
    .describe("How many names to skip, in name order (default 0)")
    .optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIMIT)
    .describe(`How many names to return at most (default ${LIMIT})`)
    .optional(),
});

type Variable = { key: string; values: Array<{ environmentId: string; isSecret: boolean }> };
type Environment = EnvironmentVariablesEnvironment;

const isBranch = (environment: Environment) => environment.parentEnvironmentId !== null;

const environmentLabel = (environment: Environment) =>
  isBranch(environment) && environment.branchName
    ? `${TYPE_LABELS[environment.type]} branch ${untrusted(environment.branchName, "environment-branch", BRANCH_NAME_CHARS)}`
    : TYPE_LABELS[environment.type];

const variableName = (key: string) => untrusted(key, "environment-variable-name", NAME_CHARS);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "es"}`;

const ROLE_DENIES = "not read, your role does not allow reading environment variables";

/** One line per root environment the role may not read, one counted line for its branches. */
function notReadLines(unreadable: Environment[]): string[] {
  const roots = unreadable
    .filter((environment) => !isBranch(environment))
    .map((environment) => `${environmentLabel(environment)}: ${ROLE_DENIES} there.`);
  const branchTypes = [...new Set(unreadable.filter(isBranch).map((e) => e.type))];
  const branches = branchTypes.map((type) => {
    const count = unreadable.filter((e) => isBranch(e) && e.type === type).length;
    return `${plural(count, `${TYPE_LABELS[type]} branch`)}: ${ROLE_DENIES} in them.`;
  });
  return [...roots, ...branches];
}

/** Roots first, a branch only where it sets its own value: branches inherit the rest at runtime. */
function setInLine(variable: Variable, readable: Environment[]) {
  const valueIn = (environment: Environment) =>
    variable.values.find((v) => v.environmentId === environment.id);
  const roots = readable
    .filter((environment) => !isBranch(environment) && valueIn(environment))
    .map((environment) => {
      const notes = [
        ...(valueIn(environment)!.isSecret ? ["secret"] : []),
        ...(readable.some((e) => e.parentEnvironmentId === environment.id)
          ? ["inherited by its branches unless they set their own"]
          : []),
      ];
      return `${environmentLabel(environment)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    });
  const branches = readable.filter((environment) => isBranch(environment) && valueIn(environment));
  const named = branches
    .slice(0, BRANCHES_PER_NAME)
    .map(
      (environment) =>
        `${environmentLabel(environment)}${valueIn(environment)!.isSecret ? " (secret)" : ""}`
    );
  const more = branches.length - named.length;
  const rest =
    more > 0
      ? [
          `and ${plural(more, "more branch")} with their own value, not named here (the dashboard's Environment variables page lists each branch)`,
        ]
      : [];
  return `  set in: ${[...roots, ...named, ...rest].join(", ")}`;
}

/** Where each variable is set, and which of the compared environments lack it. */
function formatEnvironmentVariableNames({
  variables,
  readable,
  unreadable,
  offset,
  limit,
  total,
  maxChars,
}: {
  variables: Variable[];
  readable: Environment[];
  unreadable: Environment[];
  offset: number;
  limit: number;
  total: number;
  maxChars: number;
}): string {
  const notRead = notReadLines(unreadable);
  if (total === 0) {
    return [
      readable.length === 0
        ? "No environment of this project could be read."
        : "No environment variables are set in the environments you can read.",
      ...notRead,
    ].join("\n");
  }
  if (variables.length === 0) {
    return `No environment variables at offset ${offset}: there are ${total} in total, so the last one is at offset ${total - 1}. Call ${TOOL} with a lower offset, or offset 0 to start again.`;
  }

  // Branches inherit their parent's variables, so a name missing on a branch is not missing.
  const compared = readable.filter((environment) => !isBranch(environment));
  const rendered = variables.map((variable) => {
    const missing = compared.filter(
      (environment) => !variable.values.some((v) => v.environmentId === environment.id)
    );
    return {
      entry: [`- ${variableName(variable.key)}`, setInLine(variable, readable)],
      difference:
        missing.length > 0
          ? [
              `- ${variableName(variable.key)}: not set in ${missing.map(environmentLabel).join(", ")}`,
            ]
          : [],
    };
  });

  const header = [
    `Environment variable names at offset ${offset} (${total} in total). Values are never shown.`,
    ...notRead,
  ];
  const fixedChars = header.join("\n").length + 1_000;
  const ends = rendered.reduce<number[]>(
    (sums, item) => [
      ...sums,
      (sums.at(-1) ?? fixedChars) + [...item.entry, ...item.difference].join("\n").length + 2,
    ],
    []
  );
  // At least one name, so following the hint always moves forward.
  const shown = rendered.slice(0, Math.max(1, ends.filter((end) => end <= maxChars).length));
  const cut = shown.length < rendered.length;
  const nextOffset = offset + shown.length;
  const differences = shown.flatMap((item) => item.difference);

  return [
    ...header,
    ...shown.flatMap((item) => item.entry),
    "",
    `Differences for the names above, between ${compared.map(environmentLabel).join(", ") || "no environments"} (branches inherit from their parent and are not compared):`,
    ...(compared.length < 2
      ? ["Nothing to compare: fewer than two environments could be read."]
      : differences.length > 0
        ? differences
        : ["None: every name above is set in each of them."]),
    ...(cut
      ? [
          `Cut to stay under ${maxChars} characters: ${shown.length} of the ${rendered.length} names read are shown.`,
        ]
      : []),
    ...(nextOffset < total
      ? [
          `More variables exist: call ${TOOL} with offset ${nextOffset} and limit ${limit} to continue after the last name shown.`,
        ]
      : []),
  ].join("\n");
}

export function createEnvVarTools({
  budgetMs = READ_BUDGET_MS,
  maxChars = MAX_CHARS,
}: { budgetMs?: number; maxChars?: number } = {}): McpToolDefinition[] {
  return [
    defineReadTool({
      name: TOOL,
      title: "List Environment Variables",
      description: `List the environment variable names of a project, never their values: for each name, the environments where it is set and whether it is secret there, then the names set in some environments but not others. Environments your role may not read are named but not read. Only available through an OAuth connection with the read:envvars scope. Returns up to ${LIMIT} names per call and names at most ${BRANCHES_PER_NAME} branches per name; each answer says the offset to continue from.`,
      shape: ListEnvironmentVariablesInput.shape,
      auth: { action: "read", subject: "envvars", anyEnvType: true },
      run: async (input, ctx) => {
        const { identity } = ctx;
        if (identity.kind !== "uat") {
          return plainError(
            "This tool is only available through an OAuth connection, not a personal access token. Connect the MCP server with OAuth and grant read:envvars."
          );
        }
        const projectId = ctx.subject?.projectId;
        if (!projectId) return plainError("Project not found");

        const stopped = (reason: "timeout" | "aborted") =>
          plainError(
            reason === "timeout"
              ? `Reading environment variables took longer than ${budgetMs / 1000} seconds and was stopped. Try again.`
              : "The request was cancelled before the environment variables were read."
          );
        const budget = startReadBudget(budgetMs, ctx.signal);

        const listed = await budget.read(() =>
          loadEnvironmentVariablesEnvironments(
            $replica,
            { userId: identity.userId, projectId },
            { skipProjectAccessCheck: true }
          )
        );
        if (!listed.ok) return stopped(listed.reason);
        const mayRead = (environment: EnvironmentVariablesEnvironment) =>
          ctx.ability?.can("read", { type: "envvars", envType: environment.type }) ?? false;
        const readable = listed.value.environments.filter(mayRead);
        const unreadable = listed.value.environments.filter((e) => !mayRead(e));

        const offset = input.offset ?? 0;
        const limit = input.limit ?? LIMIT;
        const where = {
          projectId,
          values: { some: { environmentId: { in: boundedIn(readable.map((e) => e.id)) } } },
        };
        const [counted, found] =
          readable.length === 0
            ? [
                { ok: true as const, value: 0 },
                { ok: true as const, value: [] },
              ]
            : await Promise.all([
                budget.read(() => $replica.environmentVariable.count({ where })),
                budget.read(() =>
                  $replica.environmentVariable.findMany({
                    select: {
                      key: true,
                      values: {
                        select: { environmentId: true, isSecret: true },
                        where: { environmentId: { in: boundedIn(readable.map((e) => e.id)) } },
                      },
                    },
                    where,
                    orderBy: { key: "asc" },
                    skip: offset,
                    take: limit,
                  })
                ),
              ]);
        if (!counted.ok) return stopped(counted.reason);
        if (!found.ok) return stopped(found.reason);

        if (readable.length > 0) {
          notePersonalAccessTokenAuthentication(ctx.request, {
            userId: identity.userId,
            userActor: { pat: identity.sourceTokenId },
          });
          for (const environment of readable) {
            recordEnvironmentVariableRead({
              action: "envvar.listed",
              organizationId: ctx.subject!.organizationId,
              projectId,
              environmentId: environment.id,
              environmentType: environment.type,
              target: environmentReadTarget(environment),
            });
          }
        }

        return textResult(
          formatEnvironmentVariableNames({
            variables: found.value,
            readable,
            unreadable,
            offset,
            limit,
            total: counted.value,
            maxChars,
          })
        );
      },
    }),
  ];
}

export const envVarTools = createEnvVarTools();
