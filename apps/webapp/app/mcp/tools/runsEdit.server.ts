import type { TaskRun } from "@trigger.dev/database";
import {
  applyMetadataOperations,
  parsePacket,
  type UpdateMetadataRequestBody,
} from "@trigger.dev/core/v3";
import type { RbacAbility } from "@trigger.dev/plugins";
import type { MollifierBuffer } from "@trigger.dev/redis-worker";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { parseDelay } from "~/utils/delays";
import { applyMetadataMutationToBufferedRun } from "~/v3/mollifier/applyMetadataMutation.server";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { RUN_UPDATABLE_WINDOW_MS } from "~/services/metadata/updateMetadata.server";
import { runStore } from "~/v3/runStore.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { canonicalJson } from "../confirm/confirmation.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpPreviewRefusal, McpSubject } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { dashboardUrl, resolveToolEnvironment, textResult } from "./define.server";
import { defineWriteTool, fencedError, staleApproval } from "./defineWrite.server";
import {
  describeOperations,
  describeRemovedKeys,
  describeReplacement,
  escapeText,
  quote,
} from "./format/runsEditPreview";
import {
  AddRunTagsInput,
  RescheduleRunInput,
  ResetRunIdempotencyKeyInput,
  UpdateRunMetadataInput,
} from "./schemas/runsWrite";

type BufferedRun = NonNullable<Awaited<ReturnType<typeof findRunByIdWithMollifierFallback>>>;

const JUST_TRIGGERED = "The run was just triggered and is not editable yet; retry shortly.";

type Scope = { runId: string; environmentId: string; organizationId: string };

export type RunsEditOptions = {
  resetIdempotencyKey?: (taskRun: TaskRun, environment: AuthenticatedEnvironment) => Promise<void>;
  updateMetadata?: (
    runId: string,
    body: UpdateMetadataRequestBody,
    environment: AuthenticatedEnvironment,
    ability: RbacAbility | undefined
  ) => Promise<{ metadata?: Record<string, unknown> } | undefined>;
  pushTags?: (
    taskRun: TaskRun,
    tags: string[],
    environment: AuthenticatedEnvironment
  ) => Promise<void>;
  rescheduleRun?: (taskRun: TaskRun, delay: string) => Promise<void>;
  getBuffer?: () => MollifierBuffer | null;
};

const defaultResetIdempotencyKey: NonNullable<RunsEditOptions["resetIdempotencyKey"]> = async (
  taskRun,
  environment
) => {
  const { ResetIdempotencyKeyService } = await import("~/v3/services/resetIdempotencyKey.server");
  await new ResetIdempotencyKeyService().call(
    taskRun.idempotencyKey!,
    taskRun.taskIdentifier,
    environment
  );
};

const defaultUpdateMetadata: NonNullable<RunsEditOptions["updateMetadata"]> = async (
  runId,
  body,
  environment,
  ability
) => {
  const { updateMetadataService } =
    await import("~/services/metadata/updateMetadataInstance.server");
  const { publishChangeRecord } =
    await import("~/services/realtime/runChangeNotifierInstance.server");
  const result = await updateMetadataService.call(runId, body, environment, { ability });
  if (result?.updatedAtMs !== undefined) {
    publishChangeRecord({
      runId: result.runId,
      envId: environment.id,
      tags: result.runTags,
      batchId: result.batchId,
      updatedAtMs: result.updatedAtMs,
    });
  }
  return result;
};

const defaultPushTags: NonNullable<RunsEditOptions["pushTags"]> = async (
  taskRun,
  tags,
  environment
) => {
  const { publishChangeRecord } =
    await import("~/services/realtime/runChangeNotifierInstance.server");
  const updated = await runStore.pushTags(
    taskRun.id,
    tags,
    { runtimeEnvironmentId: environment.id },
    prisma
  );
  publishChangeRecord({
    runId: taskRun.id,
    envId: environment.id,
    tags: (taskRun.runTags ?? []).concat(tags),
    batchId: taskRun.batchId,
    updatedAtMs: updated.updatedAt.getTime(),
  });
};

const defaultRescheduleRun: NonNullable<RunsEditOptions["rescheduleRun"]> = async (
  taskRun,
  delay
) => {
  const { RescheduleTaskRunService } = await import("~/v3/services/rescheduleTaskRun.server");
  await new RescheduleTaskRunService().call(taskRun, { delay });
};

async function findRunInEnvironment(runId: string, environment: AuthenticatedEnvironment) {
  return runStore.findRun({ friendlyId: runId, runtimeEnvironmentId: environment.id }, prisma);
}

const scopeOf = (runId: string, environment: AuthenticatedEnvironment): Scope => ({
  runId,
  environmentId: environment.id,
  organizationId: environment.organizationId,
});

function runLink(environment: AuthenticatedEnvironment, runId: string) {
  return `[View in dashboard](${dashboardUrl(`/projects/v3/${environment.project.externalRef}/runs/${runId}`)})`;
}

async function toMetadataObject(data: unknown, dataType: string | undefined) {
  const parsed =
    typeof data === "string" && data.length > 0
      ? await parsePacket({ data, dataType: dataType ?? "application/json" })
      : {};
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

const isRunUpdatable = (completedAt: Date | null) =>
  !completedAt || completedAt.getTime() > Date.now() - RUN_UPDATABLE_WINDOW_MS;

const normalizeTags = (tags: string[]) => [...new Set(tags.filter((t) => t.trim().length > 0))];

const tooManyTags = (total?: number) =>
  `Runs can only have ${MAX_TAGS_PER_RUN} tags${total === undefined ? "" : `, you're trying to set ${total}`}. No tags were added`;

function snapshotTags(payload: string | undefined): string[] | undefined {
  try {
    const tags =
      payload === undefined ? undefined : (JSON.parse(payload) as { tags?: unknown }).tags;
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : undefined;
  } catch {
    return undefined;
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function ignoredEntries(given: string[], kept: string[]): string[] {
  const blank = given.filter((t) => t.trim().length === 0).length;
  const duplicate = given.length - blank - kept.length;
  const parts = [
    ...(duplicate > 0 ? [plural(duplicate, "duplicate")] : []),
    ...(blank > 0 ? [`${blank} blank ${blank === 1 ? "entry" : "entries"}`] : []),
  ];
  return parts.length > 0 ? [`Ignored ${parts.join(" and ")} in the tags given.`] : [];
}

function serviceError(error: unknown, source: string) {
  if (error instanceof ServiceValidationError) return fencedError(error.message, source);
  throw error;
}

export function createRunsEditTools(options: RunsEditOptions = {}): McpToolDefinition[] {
  const resetIdempotencyKey = options.resetIdempotencyKey ?? defaultResetIdempotencyKey;
  const updateMetadata = options.updateMetadata ?? defaultUpdateMetadata;
  const pushTags = options.pushTags ?? defaultPushTags;
  const rescheduleRun = options.rescheduleRun ?? defaultRescheduleRun;
  const getBuffer = options.getBuffer ?? getMollifierBuffer;

  const findBuffered = (scope: Scope) => findRunByIdWithMollifierFallback(scope, { getBuffer });

  async function previewRun<T>(
    runId: string,
    subject: McpSubject | null,
    find: (environmentId: string) => Promise<T | null>
  ): Promise<
    { run: T; buffered?: undefined } | { run: null; buffered: BufferedRun } | McpPreviewRefusal
  > {
    if (!subject?.environmentId) return { refuse: "Environment not found" };
    const run = await find(subject.environmentId);
    if (run) return { run };
    const buffered = await findBuffered({
      runId,
      environmentId: subject.environmentId,
      organizationId: subject.organizationId,
    });
    return buffered ? { run: null, buffered } : { refuse: "Run not found" };
  }

  async function currentMetadata(runId: string, subject: McpSubject | null) {
    if (!subject?.environmentId) return undefined;
    const run = await runStore.findRun(
      { friendlyId: runId, runtimeEnvironmentId: subject.environmentId },
      { select: { metadata: true, metadataType: true, completedAt: true } },
      prisma
    );
    if (run && !isRunUpdatable(run.completedAt)) return "completed";
    if (run) return toMetadataObject(run.metadata, run.metadataType);
    const buffered = await findBuffered({
      runId,
      environmentId: subject.environmentId,
      organizationId: subject.organizationId,
    });
    return buffered ? toMetadataObject(buffered.metadata, buffered.metadataType) : null;
  }

  async function metadataPreview(
    args: UpdateRunMetadataInput,
    subject: McpSubject | null
  ): Promise<string | McpPreviewRefusal> {
    const lines = args.operations
      ? describeOperations(args.operations)
      : describeReplacement(args.metadata ?? {});
    const current = await currentMetadata(args.runId, subject);
    if (current === null) return { refuse: "Run not found" };
    if (current === "completed") {
      return {
        refuse: `Run ${quote(args.runId)}: Cannot update metadata for a completed run; nothing changed.`,
      };
    }
    if (current) {
      const result = args.operations
        ? applyMetadataOperations(current, args.operations).newMetadata
        : (args.metadata ?? {});
      if (canonicalJson(result) === canonicalJson(current)) {
        return {
          refuse: `The metadata of run ${quote(args.runId)} already matches; nothing changed.`,
        };
      }
      lines.push(describeRemovedKeys(current, result));
    }
    return [
      `update_run_metadata on run ${quote(args.runId)} in ${args.environment}:`,
      ...lines,
    ].join("\n");
  }

  function idempotencyPreview(
    runId: string,
    environment: string,
    run: { idempotencyKey: string; taskIdentifier: string }
  ) {
    return [
      `reset_run_idempotency_key in ${environment}: clear idempotency key ${escapeText(run.idempotencyKey)} of task ${escapeText(run.taskIdentifier)}`,
      `This affects every run of that task in ${environment} with this key, including run ${quote(runId)}.`,
    ].join("\n");
  }

  return [
    defineWriteTool({
      name: "reset_run_idempotency_key",
      title: "Reset Run Idempotency Key",
      description:
        "Clear the idempotency key of a run, so a new trigger with the same key starts a new run instead of returning this one. The run ID starts with run_",
      shape: ResetRunIdempotencyKeyInput.shape,
      approval: "configurable",
      auth: { action: "write", subject: "runs" },
      confirm: {
        preview: async (args, subject) => {
          const found = await previewRun(args.runId, subject, (environmentId) =>
            runStore.findRun(
              { friendlyId: args.runId, runtimeEnvironmentId: environmentId },
              { select: { idempotencyKey: true, taskIdentifier: true } },
              prisma
            )
          );
          if ("refuse" in found) return found;
          const { run } = found;
          if (!run) return { refuse: JUST_TRIGGERED };
          if (!run.idempotencyKey) {
            return {
              refuse: `Run ${quote(args.runId)} has no idempotency key to reset; nothing changed.`,
            };
          }
          return idempotencyPreview(args.runId, args.environment, {
            idempotencyKey: run.idempotencyKey,
            taskIdentifier: run.taskIdentifier,
          });
        },
      },
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return fencedError("Environment not found", "idempotency-error");

        const taskRun = await findRunInEnvironment(input.runId, environment);
        if (!taskRun) {
          const buffered = await findBuffered(scopeOf(input.runId, environment));
          return fencedError(buffered ? JUST_TRIGGERED : "Run not found", "idempotency-error");
        }
        if (!taskRun.idempotencyKey) {
          return fencedError("This run does not have an idempotency key", "idempotency-error");
        }
        const stale = staleApproval(
          ctx,
          idempotencyPreview(input.runId, input.environment, {
            idempotencyKey: taskRun.idempotencyKey,
            taskIdentifier: taskRun.taskIdentifier,
          })
        );
        if (stale) return stale;

        try {
          await resetIdempotencyKey(taskRun, environment);
        } catch (error) {
          return serviceError(error, "idempotency-error");
        }

        return textResult(
          [
            `Reset the idempotency key of run ${input.runId}.`,
            runLink(environment, input.runId),
          ].join("\n")
        );
      },
    }),
    defineWriteTool({
      name: "update_run_metadata",
      title: "Update Run Metadata",
      description:
        "Update the metadata of a run that has not finished. Pass metadata to replace it all, or operations to change single keys. The run ID starts with run_",
      shape: UpdateRunMetadataInput.shape,
      approval: "configurable",
      auth: { action: "write", subject: "runs" },
      confirm: {
        preview: (args, subject) => metadataPreview(args, subject),
      },
      run: async (input, ctx) => {
        if ((input.metadata === undefined) === (input.operations === undefined)) {
          return fencedError(
            "Invalid arguments: pass either metadata or operations",
            "metadata-error"
          );
        }

        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return fencedError("Environment not found", "metadata-error");

        const body: UpdateMetadataRequestBody = input.operations
          ? { operations: input.operations }
          : { metadata: input.metadata };

        const rebuilt = await metadataPreview(input, ctx.subject);
        if (typeof rebuilt !== "string") return fencedError(rebuilt.refuse, "metadata-error");
        const stale = staleApproval(ctx, rebuilt);
        if (stale) return stale;

        let metadata: Record<string, unknown> | undefined;
        try {
          const taskRun = await findRunInEnvironment(input.runId, environment);
          if (taskRun) {
            const result = await updateMetadata(input.runId, body, environment, ctx.ability);
            if (!result) return fencedError("Run not found", "metadata-error");
            metadata = result.metadata;
          } else {
            const outcome = await applyMetadataMutationToBufferedRun({
              ...scopeOf(input.runId, environment),
              maximumSize: env.TASK_RUN_METADATA_MAXIMUM_SIZE,
              maxRetries: env.TRIGGER_MOLLIFIER_METADATA_MAX_RETRIES,
              backoffBaseMs: env.TRIGGER_MOLLIFIER_METADATA_BACKOFF_BASE_MS,
              backoffStepMs: env.TRIGGER_MOLLIFIER_METADATA_BACKOFF_STEP_MS,
              body,
              ability: ctx.ability,
              buffer: getBuffer(),
            });
            if (outcome.kind === "not_found") return fencedError("Run not found", "metadata-error");
            if (outcome.kind === "metadata_too_large") {
              return fencedError(
                `Metadata exceeds maximum size of ${outcome.maximumSize} bytes`,
                "metadata-error"
              );
            }
            if (outcome.kind !== "applied") return fencedError(JUST_TRIGGERED, "metadata-error");
            metadata = outcome.newMetadata;
          }
        } catch (error) {
          return serviceError(error, "metadata-error");
        }

        const keys = Object.keys(metadata ?? {});
        return textResult(
          [
            `Updated the metadata of run ${input.runId}. It now has ${keys.length} key${keys.length === 1 ? "" : "s"}.`,
            runLink(environment, input.runId),
          ].join("\n")
        );
      },
    }),
    defineWriteTool({
      name: "add_run_tags",
      title: "Add Run Tags",
      description: `Add tags to a run. A run can have up to ${MAX_TAGS_PER_RUN} tags. The run ID starts with run_`,
      shape: AddRunTagsInput.shape,
      approval: "configurable",
      auth: { action: "write", subject: "runs" },
      confirm: {
        preview: async (args, subject) => {
          const tags = normalizeTags(args.tags);
          if (tags.length === 0) return { refuse: "No tags to add" };
          const found = await previewRun(args.runId, subject, (environmentId) =>
            runStore.findRun(
              { friendlyId: args.runId, runtimeEnvironmentId: environmentId },
              { select: { runTags: true } },
              prisma
            )
          );
          if ("refuse" in found) return found;
          const existing = (found.run ?? found.buffered).runTags ?? [];
          const newTags = tags.filter((t) => !existing.includes(t));
          if (newTags.length === 0) {
            return {
              refuse: `Run ${quote(args.runId)} already has every tag given; nothing changed.`,
            };
          }
          if (existing.length + newTags.length > MAX_TAGS_PER_RUN) {
            return {
              refuse: `Run ${quote(args.runId)}: ${tooManyTags(existing.length + newTags.length)}; nothing changed.`,
            };
          }
          return [
            `add_run_tags on run ${quote(args.runId)} in ${args.environment}: add ${tags.map(escapeText).join(", ")}`,
            "Tags the run already has are skipped.",
            `A run can hold at most ${MAX_TAGS_PER_RUN} tags; if these would take it past ${MAX_TAGS_PER_RUN}, none of them are added.`,
          ].join("\n");
        },
      },
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return fencedError("Environment not found", "tags-error");

        const tags = normalizeTags(input.tags);
        const ignored = ignoredEntries(input.tags, tags);
        if (tags.length === 0) {
          return textResult([`No new tags to add to run ${input.runId}.`, ...ignored].join("\n"));
        }
        const fenced = (list: string[]) => fenceUntrusted(list.join(", "), "run-tags");
        const report = (verb: string, list: string[], skipped: string[] = []) =>
          textResult(
            [
              list.length === 0
                ? `No new tags to add to run ${input.runId}.`
                : `${verb} ${plural(list.length, "tag")} ${verb === "Added" ? "to" : "for"} run ${input.runId}: ${fenced(list)}`,
              ...(skipped.length > 0
                ? [
                    `Skipped ${plural(skipped.length, "tag")} the run already has: ${fenced(skipped)}`,
                  ]
                : []),
              ...ignored,
              runLink(environment, input.runId),
            ].join("\n")
          );
        const tooMany = (total?: number) => fencedError(`${tooManyTags(total)}.`, "tags-error");

        const outcome = await mutateWithFallback({
          ...scopeOf(input.runId, environment),
          bufferPatch: { type: "append_tags", tags, maxTags: MAX_TAGS_PER_RUN },
          pgMutation: async (taskRun) => {
            const existing = taskRun.runTags ?? [];
            const newTags = tags.filter((t) => !existing.includes(t));
            if (existing.length + newTags.length > MAX_TAGS_PER_RUN) {
              return tooMany(existing.length + newTags.length);
            }
            const skipped = tags.filter((t) => existing.includes(t));
            if (newTags.length > 0) await pushTags(taskRun, newTags, environment);
            return report("Added", newTags, skipped);
          },
          synthesisedResponse: ({ bufferEntry }) => {
            const existing = snapshotTags(bufferEntry?.payload);
            if (!existing) return report("Requested", tags);
            return report(
              "Added",
              tags.filter((t) => !existing.includes(t)),
              tags.filter((t) => existing.includes(t))
            );
          },
          rejectedResponse: () => tooMany(),
          abortSignal: ctx.signal,
          getBuffer,
        });

        if (outcome.kind === "not_found") return fencedError("Run not found", "tags-error");
        if (outcome.kind === "timed_out") return fencedError(JUST_TRIGGERED, "tags-error");
        return outcome.response;
      },
    }),
    defineWriteTool({
      name: "reschedule_run",
      title: "Reschedule Run",
      description:
        "Change when a delayed run starts. Only runs that are still delayed can be rescheduled. The run ID starts with run_",
      shape: RescheduleRunInput.shape,
      approval: "configurable",
      auth: { action: "write", subject: "runs" },
      confirm: {
        preview: async (args, subject) => {
          if (!(await parseDelay(args.delay))) {
            return { refuse: `Invalid delay: ${quote(args.delay)}` };
          }
          const found = await previewRun(args.runId, subject, (environmentId) =>
            runStore.findRun(
              { friendlyId: args.runId, runtimeEnvironmentId: environmentId },
              { select: { status: true } },
              prisma
            )
          );
          if ("refuse" in found) return found;
          if (found.run ? found.run.status !== "DELAYED" : !found.buffered.delayUntil) {
            return { refuse: `Run ${quote(args.runId)} is not delayed; nothing changed.` };
          }
          const at = new Date(args.delay);
          const when = Number.isNaN(at.getTime())
            ? `start after a delay of ${quote(args.delay)}, counted from the moment this is approved and run`
            : `start at ${at.toISOString()} (UTC)`;
          return `reschedule_run on run ${quote(args.runId)} in ${args.environment}: ${when}`;
        },
      },
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return fencedError("Environment not found", "reschedule-error");

        const delayUntil = await parseDelay(input.delay);
        if (!delayUntil) return fencedError(`Invalid delay: ${input.delay}`, "reschedule-error");

        const notDelayed = () =>
          fencedError("Cannot reschedule a run that is not delayed", "reschedule-error");
        const rescheduled = async () => {
          const updated = await findRunInEnvironment(input.runId, environment);
          const startsAt = updated?.delayUntil ?? delayUntil;
          return textResult(
            [
              `Rescheduled run ${input.runId} to start at ${startsAt.toISOString()}.`,
              runLink(environment, input.runId),
            ].join("\n")
          );
        };

        if (!(await findRunInEnvironment(input.runId, environment))) {
          const buffered = await findBuffered(scopeOf(input.runId, environment));
          if (buffered && !buffered.delayUntil) return notDelayed();
        }

        try {
          const outcome = await mutateWithFallback({
            ...scopeOf(input.runId, environment),
            bufferPatch: { type: "set_delay", delayUntil: delayUntil.toISOString() },
            pgMutation: async (taskRun) => {
              if (taskRun.status !== "DELAYED") return notDelayed();
              await rescheduleRun(taskRun, input.delay);
              return rescheduled();
            },
            synthesisedResponse: () =>
              textResult(
                [
                  `Rescheduled run ${input.runId} to start at ${delayUntil.toISOString()}.`,
                  runLink(environment, input.runId),
                ].join("\n")
              ),
            abortSignal: ctx.signal,
            getBuffer,
          });

          if (outcome.kind === "not_found") return fencedError("Run not found", "reschedule-error");
          if (outcome.kind === "timed_out") return fencedError(JUST_TRIGGERED, "reschedule-error");
          return outcome.response;
        } catch (error) {
          return serviceError(error, "reschedule-error");
        }
      },
    }),
  ];
}

export const runsEditTools: McpToolDefinition[] = createRunsEditTools();
