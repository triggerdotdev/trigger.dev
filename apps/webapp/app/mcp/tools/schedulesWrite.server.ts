import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import cronstrue from "cronstrue";
import { $transaction, prisma } from "~/db.server";
import { env } from "~/env.server";
import { lockScheduleForRunTokenMutation } from "~/models/schedules.server";
import { logger } from "~/services/logger.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import {
  assertCronMeetsFreeMinimum,
  resolveMinimumWindowOnUpdate,
  resolvePlanState,
} from "~/v3/freeSchedulePolicy.server";
import { resolveNewScheduleDefaultWindowSeconds } from "~/v3/scheduleDefaultWindow.server";
import {
  calculateNextScheduleRunTimes,
  formatScheduleWindow,
  normalizeScheduleWindow,
} from "~/v3/scheduleWindow.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { CheckScheduleService } from "~/v3/services/checkSchedule.server";
import { DeleteTaskScheduleService } from "~/v3/services/deleteTaskSchedule.server";
import { SetActiveOnTaskScheduleService } from "~/v3/services/setActiveOnTaskSchedule.server";
import type { McpPreviewRefusal, McpSubject } from "../gate/types";
import type { McpToolContext } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import { textResult } from "./define.server";
import { defineWriteTool, staleAnswer, staleApproval } from "./defineWrite.server";
import {
  anchorFrom,
  DEV_NOTE,
  describeWindow,
  environmentLabel,
  FIRE_TIMES,
  fireTimeLines,
  refusalText,
  scheduleId,
  scheduleNotFound,
  scheduleSummary,
  taskIdText,
  storedAnchor,
  type EnvironmentFacts,
  type FireTime,
  type ScheduleFacts,
  type WindowFacts,
} from "./format/schedules";
import { plainError } from "./format/insights";
import { untrusted } from "./format/logFields";
import { escapeText } from "./format/runsEditPreview";
import { startReadBudget } from "./readBudget.server";
import { CreateScheduleInput, ScheduleIdInput, UpdateScheduleInput } from "./schemas/schedules";

const auth = { action: "write", subject: "tasks" } as const;

type Environment = EnvironmentFacts & {
  id: string;
  type: RuntimeEnvironmentType;
  projectId: string;
  organizationId: string;
};

type StoredSchedule = NonNullable<Awaited<ReturnType<typeof findSchedule>>>;

type Plan<T> = { preview: string; value: T } | McpPreviewRefusal;

type Read = ReturnType<typeof startReadBudget>["read"];

/**
 * The schedule's revision is its last update. Firing writes only the instance (its phase, once)
 * and runs, never the schedule, so a schedule that fires stays at the same revision.
 */
const revisionLine = (schedule: { updatedAt: Date }) =>
  `Schedule revision ${schedule.updatedAt.toISOString()}: if the schedule changes before this runs, it is refused.`;

const READ_BUDGET_MS = 10_000;
const SERVICE_ERROR_CHARS = 2_000;
const STOPPED = {
  aborted: "The request was cancelled before the schedule was read; nothing changed.",
  timeout: "Reading the schedule took too long; nothing changed. Try again.",
};
const stoppedRefusal = (read: { reason: keyof typeof STOPPED }) => ({
  refuse: STOPPED[read.reason],
});

const KEY_NOW_TAKEN =
  "A schedule with this deduplication key was created after approval, so no schedule was created and nothing changed. Use list_schedules to find it, or create with another key.";

const KEY_TAKEN =
  "This deduplication key is already used by a schedule that can't be changed from this environment. Use another key; nothing changed.";

function findEnvironment(subject: McpSubject | null): Promise<Environment | null> {
  if (!subject?.projectId || !subject.environmentId) return Promise.resolve(null);
  return prisma.runtimeEnvironment.findFirst({
    where: { id: subject.environmentId, projectId: subject.projectId },
    select: {
      id: true,
      type: true,
      slug: true,
      branchName: true,
      projectId: true,
      organizationId: true,
    },
  });
}

function findSchedule(projectId: string, friendlyId: string) {
  return prisma.taskSchedule.findFirst({
    where: { projectId, friendlyId },
    select: {
      id: true,
      friendlyId: true,
      type: true,
      taskIdentifier: true,
      generatorExpression: true,
      generatorDescription: true,
      timezone: true,
      externalId: true,
      deduplicationKey: true,
      userProvidedDeduplicationKey: true,
      active: true,
      windowDurationSeconds: true,
      windowPercentage: true,
      defaultWindowDurationSeconds: true,
      minimumWindowDurationSeconds: true,
      updatedAt: true,
      instances: { select: { environmentId: true, schedulePhase: true } },
    },
  });
}

const facts = (s: StoredSchedule): ScheduleFacts => ({
  ...s,
  cron: s.generatorExpression,
  cronDescription: s.generatorDescription,
});

async function findWritable(
  environment: Environment,
  id: string,
  read: Read
): Promise<{ schedule: StoredSchedule } | McpPreviewRefusal> {
  const found = await read(() => findSchedule(environment.projectId, id));
  if (!found.ok) return stoppedRefusal(found);
  const schedule = found.value;
  const here = schedule?.instances.some((i) => i.environmentId === environment.id);
  if (!schedule || !here) return { refuse: scheduleNotFound(id) };
  if (schedule.type === "DECLARATIVE") {
    return {
      refuse: `Schedule ${scheduleId(id)} is declarative: it is defined in code with schedules.task and replaced on every deploy, so it can't be changed here. Change it in the task's code and deploy; nothing changed.`,
    };
  }
  if (schedule.instances.some((i) => i.environmentId !== environment.id)) {
    return {
      refuse: `Schedule ${scheduleId(id)} also runs in another environment, so changing it here would change that environment too. Change it on the schedule's page in the dashboard; nothing changed.`,
    };
  }
  return { schedule };
}

function fireTimes(
  f: WindowFacts & { cron: string; timezone: string; deduplicationKey: string },
  environmentId: string,
  schedulePhase: number | null,
  anchor: Date
): FireTime[] {
  return calculateNextScheduleRunTimes({
    ...f,
    environmentId,
    schedulePhase,
    phaseSecret: env.SCHEDULE_PHASE_SEED,
    from: anchor,
    count: FIRE_TIMES,
  });
}

async function validationRefusal(prefix: string, check: () => Promise<void>, read: Read) {
  try {
    const checked = await read(check);
    return checked.ok ? undefined : stoppedRefusal(checked);
  } catch (error) {
    if (error instanceof ServiceValidationError)
      return { refuse: refusalText(prefix, error.message) };
    throw error;
  }
}

async function createPlan(
  args: CreateScheduleInput,
  environment: Environment,
  anchor: Date,
  read: Read
): Promise<Plan<undefined>> {
  const worker = await read(() => findCurrentWorkerFromEnvironment(environment, prisma));
  if (!worker.ok) return stoppedRefusal(worker);
  const workerId = worker.value?.id;
  const found = workerId
    ? await read(() =>
        prisma.backgroundWorkerTask.findFirst({
          where: { workerId, slug: args.taskId },
          select: { triggerSource: true },
        })
      )
    : { ok: true as const, value: null };
  if (!found.ok) return stoppedRefusal(found);
  const task = found.value;
  if (!task) {
    return {
      refuse: `Task ${taskIdText(args.taskId)} is not in this environment's current version. Deploy it to this environment (for a dev environment, run the dev command), then try again; nothing changed.`,
    };
  }
  if (task.triggerSource !== "SCHEDULED") {
    return {
      refuse: `Task ${taskIdText(args.taskId)} is not a scheduled task. Only tasks defined with schedules.task can have schedules; nothing changed.`,
    };
  }

  const invalid = await validationRefusal(
    "Cannot create this schedule",
    () =>
      new CheckScheduleService(prisma).call(
        environment.projectId,
        {
          cron: args.cron,
          timezone: args.timezone,
          taskIdentifier: args.taskId,
          window: args.window,
        },
        [environment.id]
      ),
    read
  );
  if (invalid) return invalid;

  const key = args.deduplicationKey;
  const lookup = key
    ? await read(() =>
        prisma.taskSchedule.findFirst({
          where: { projectId: environment.projectId, deduplicationKey: key },
          select: { friendlyId: true, type: true, instances: { select: { environmentId: true } } },
        })
      )
    : { ok: true as const, value: null };
  if (!lookup.ok) return stoppedRefusal(lookup);
  const existing = lookup.value;
  if (existing) {
    const changeableHere =
      existing.type === "IMPERATIVE" &&
      existing.instances.length > 0 &&
      existing.instances.every((i) => i.environmentId === environment.id);
    return {
      refuse: changeableHere
        ? `A schedule with this deduplication key already exists: ${scheduleId(existing.friendlyId)}. Use update_schedule with that ID to change it; nothing changed.`
        : KEY_TAKEN,
    };
  }

  const timezone = args.timezone ?? "UTC";
  const defaultWindow = await read(() =>
    resolveNewScheduleDefaultWindowSeconds(prisma, environment.organizationId)
  );
  if (!defaultWindow.ok) return stoppedRefusal(defaultWindow);
  const window = {
    ...normalizeScheduleWindow(args.window),
    defaultWindowDurationSeconds: defaultWindow.value,
    minimumWindowDurationSeconds: null,
  };
  const times = fireTimes(
    { ...window, cron: args.cron, timezone, deduplicationKey: args.deduplicationKey ?? "" },
    environment.id,
    null,
    anchor
  ).map((t) => (args.deduplicationKey ? t : { nominalAt: t.nominalAt }));

  const lines = [
    `Create a schedule in the ${environmentLabel(environment)} environment that triggers task ${escapeText(args.taskId)} on its own, again and again, until it is deactivated or deleted.`,
    `Cron: ${escapeText(args.cron)} (${escapeText(cronstrue.toString(args.cron))})`,
    `Timezone: ${escapeText(timezone)}${args.timezone ? "" : " (the default)"}`,
    describeWindow(window),
    `External ID: ${args.externalId ? escapeText(args.externalId) : "none"}`,
    `Deduplication key: ${
      args.deduplicationKey
        ? `${escapeText(args.deduplicationKey)} (it can't be changed later)`
        : "a random one is generated"
    }`,
    "It is active as soon as it is created.",
    ...(environment.type === "DEVELOPMENT" ? [DEV_NOTE] : []),
    ...fireTimeLines(anchor, times, timezone),
    ...(args.deduplicationKey
      ? []
      : ["When each run starts within its window is fixed when the schedule is created."]),
  ];
  return { preview: lines.join("\n"), value: undefined };
}

type UpdateValues = {
  cron: string;
  timezone: string;
  externalId: string | null;
  window: string | undefined;
};

function changeLine(label: string, from: string | null | undefined, to: string | null | undefined) {
  const show = (value: string | null | undefined) =>
    value === null || value === undefined ? "none" : escapeText(value);
  return from === to ? [] : [`- ${label}: ${show(from)} → ${show(to)}`];
}

/** The free-plan minimum spread an update keeps, clears or enforces, or a stopped refusal. */
async function minimumOnUpdate(
  schedule: StoredSchedule,
  environment: Environment,
  read: Read
): Promise<{ minimum: ReturnType<typeof resolveMinimumWindowOnUpdate> } | McpPreviewRefusal> {
  const stored = schedule.minimumWindowDurationSeconds;
  if (stored === null) {
    return { minimum: { minimumWindowDurationSeconds: null, enforce: false, cleared: false } };
  }
  const planState = await read(() => resolvePlanState(environment.organizationId));
  if (!planState.ok) return stoppedRefusal(planState);
  return { minimum: resolveMinimumWindowOnUpdate(planState.value, stored) };
}

async function updatePlan(
  args: UpdateScheduleInput,
  environment: Environment,
  anchor: Date,
  read: Read
): Promise<Plan<{ schedule: StoredSchedule; values: UpdateValues }>> {
  const found = await findWritable(environment, args.scheduleId, read);
  if ("refuse" in found) return found;
  const { schedule } = found;

  const storedWindow = formatScheduleWindow(schedule);
  const values: UpdateValues = {
    cron: args.cron ?? schedule.generatorExpression,
    timezone: args.timezone ?? schedule.timezone,
    externalId: args.externalId === undefined ? schedule.externalId : args.externalId,
    window: args.window === undefined ? storedWindow : (args.window ?? undefined),
  };
  const changes = [
    ...changeLine("cron", schedule.generatorExpression, values.cron),
    ...changeLine("timezone", schedule.timezone, values.timezone),
    ...changeLine("external ID", schedule.externalId, values.externalId),
    ...changeLine("window", storedWindow, values.window),
  ];
  if (changes.length === 0) {
    return {
      refuse: `Schedule ${scheduleId(schedule.friendlyId)} already has these settings; nothing changed.`,
    };
  }

  const invalid = await validationRefusal(
    "Cannot update this schedule",
    async () => {
      await new CheckScheduleService(prisma).call(
        environment.projectId,
        {
          cron: values.cron,
          timezone: values.timezone,
          taskIdentifier: schedule.taskIdentifier,
          friendlyId: schedule.friendlyId,
          window: values.window,
        },
        [environment.id]
      );
    },
    read
  );
  if (invalid) return invalid;

  const resolved = await minimumOnUpdate(schedule, environment, read);
  if ("refuse" in resolved) return resolved;
  const { minimum } = resolved;
  const belowMinimum = await validationRefusal(
    "Cannot update this schedule",
    async () => {
      if (minimum.enforce && minimum.minimumWindowDurationSeconds !== null) {
        assertCronMeetsFreeMinimum({
          cron: values.cron,
          timezone: values.timezone,
          minimumWindowDurationSeconds: minimum.minimumWindowDurationSeconds,
          scheduleType: "IMPERATIVE",
        });
      }
    },
    read
  );
  if (belowMinimum) return belowMinimum;

  const after: ScheduleFacts = {
    ...facts(schedule),
    ...normalizeScheduleWindow(values.window),
    minimumWindowDurationSeconds: minimum.minimumWindowDurationSeconds,
    cron: values.cron,
    cronDescription: cronstrue.toString(values.cron),
    timezone: values.timezone,
    externalId: values.externalId,
  };
  const timingChanged =
    values.cron !== schedule.generatorExpression ||
    values.timezone !== schedule.timezone ||
    values.window !== storedWindow ||
    minimum.cleared;
  const instance = schedule.instances.find((i) => i.environmentId === environment.id);

  const lines = [
    `Update the schedule below. Changes:`,
    ...changes,
    "After the update:",
    ...scheduleSummary(after, environment),
    ...(minimum.cleared
      ? ["The free-plan minimum spread is removed because the organization is on a paid plan."]
      : []),
    timingChanged
      ? "The next run is recalculated from the new settings."
      : "When the next run starts does not change.",
    ...(schedule.active
      ? [
          ...(environment.type === "DEVELOPMENT" ? [DEV_NOTE] : []),
          ...fireTimeLines(
            anchor,
            fireTimes(
              { ...after, deduplicationKey: schedule.deduplicationKey },
              environment.id,
              instance?.schedulePhase ?? null,
              anchor
            ),
            values.timezone
          ),
        ]
      : ["It is inactive, so it triggers no runs until it is activated."]),
  ];
  return { preview: [...lines, revisionLine(schedule)].join("\n"), value: { schedule, values } };
}

async function activePlan(
  args: { scheduleId: string },
  environment: Environment,
  anchor: Date,
  active: boolean,
  read: Read
): Promise<Plan<StoredSchedule>> {
  const found = await findWritable(environment, args.scheduleId, read);
  if ("refuse" in found) return found;
  const { schedule } = found;
  if (schedule.active === active) {
    return {
      refuse: `Schedule ${scheduleId(schedule.friendlyId)} is already ${active ? "active" : "inactive"}; nothing changed.`,
    };
  }
  const instance = schedule.instances.find((i) => i.environmentId === environment.id);
  const summary = scheduleSummary(facts(schedule), environment);

  const lines = active
    ? [
        `Activate this schedule:`,
        ...summary,
        "It starts triggering runs again at its next fire time. Fire times that passed while it was inactive are not run.",
        ...(environment.type === "DEVELOPMENT" ? [DEV_NOTE] : []),
        ...fireTimeLines(
          anchor,
          fireTimes(
            { ...facts(schedule), deduplicationKey: schedule.deduplicationKey },
            environment.id,
            instance?.schedulePhase ?? null,
            anchor
          ),
          schedule.timezone
        ),
      ]
    : [
        `Deactivate this schedule:`,
        ...summary,
        "It triggers no runs until it is activated again, and fire times that pass meanwhile are not made up later. Runs it already triggered are not affected.",
      ];
  return { preview: [...lines, revisionLine(schedule)].join("\n"), value: schedule };
}

async function deletePlan(
  args: { scheduleId: string },
  environment: Environment,
  read: Read
): Promise<Plan<StoredSchedule>> {
  const found = await findWritable(environment, args.scheduleId, read);
  if ("refuse" in found) return found;
  const { schedule } = found;
  const lines = [
    `Delete this ${schedule.active ? "active" : "inactive"} schedule permanently:`,
    ...scheduleSummary(facts(schedule), environment),
    `Deduplication key: ${
      schedule.userProvidedDeduplicationKey ? escapeText(schedule.deduplicationKey) : "generated"
    }`,
    "It triggers no more runs. This cannot be undone: a schedule created again gets a new ID. Runs it already triggered are kept.",
  ];
  return { preview: [...lines, revisionLine(schedule)].join("\n"), value: schedule };
}

type Build<A, T> = (
  args: A,
  environment: Environment,
  anchor: Date,
  read: Read
) => Promise<Plan<T>>;

function planPreview<A>(build: Build<A, unknown>) {
  return async (args: A, subject: McpSubject | null) => {
    // The gate gives a preview no request signal, so only the deadline can stop its reads.
    const { read } = startReadBudget(READ_BUDGET_MS, new AbortController().signal);
    const found = await read(() => findEnvironment(subject));
    if (!found.ok) return stoppedRefusal(found);
    if (!found.value) return { refuse: "Environment not found" };
    const plan = await build(args, found.value, anchorFrom(new Date()), read);
    return "refuse" in plan ? plan : plan.preview;
  };
}

async function runPlan<A, T>(
  args: A,
  ctx: McpToolContext,
  build: Build<A, T>,
  act: (value: T, environment: Environment) => Promise<ReturnType<typeof textResult>>
) {
  const { read } = startReadBudget(READ_BUDGET_MS, ctx.signal);
  const found = await read(() => findEnvironment(ctx.subject));
  if (!found.ok) return plainError(STOPPED[found.reason]);
  const environment = found.value;
  if (!environment) return plainError("Environment not found");
  const anchor = storedAnchor(ctx.confirmation?.preview) ?? anchorFrom(new Date());
  const plan = await build(args, environment, anchor, read);
  if ("refuse" in plan) return plainError(plan.refuse);
  return staleApproval(ctx, plan.preview, plainError) ?? act(plan.value, environment);
}

const CHANGE_FAILED = "The schedule could not be changed. Try again later.";
const LOCK_REFUSED = "Schedule not found or shared with another environment";

const notOnlyHere = (id: string) =>
  `Schedule ${scheduleId(id)} no longer exists or now also runs in another environment, so it was not changed. Use get_schedule_details to see it; nothing changed.`;

function upsertFailure(error: unknown, id: string | undefined) {
  if (!(error instanceof ServiceValidationError)) throw error;
  if (error.message === LOCK_REFUSED) {
    return plainError(id ? notOnlyHere(id) : KEY_TAKEN);
  }
  return plainError(untrusted(error.message, "schedule-error", SERVICE_ERROR_CHARS));
}

/** Changes the schedule only while, under its row lock, it is still at the approved revision. */
async function lockedChange(
  environment: Environment,
  friendlyId: string,
  revision: Date,
  change: (tx: Parameters<typeof lockScheduleForRunTokenMutation>[0]) => Promise<void>
): Promise<"changed" | "stale" | "gone"> {
  return $transaction(
    prisma,
    async (tx) => {
      const locked = await lockScheduleForRunTokenMutation(
        tx,
        environment.projectId,
        friendlyId,
        environment.id
      );
      if (!locked) return "gone" as const;
      if (locked.updatedAt.getTime() !== revision.getTime()) return "stale" as const;
      await change(tx);
      return "changed" as const;
    },
    { isolationLevel: "ReadCommitted" }
  ).then((outcome) => outcome ?? "gone");
}

const SCHEDULE_CHANGED =
  "The schedule was changed by another request before this ran; nothing changed. Call the tool again.";

/** A write refused because the schedule changed: stale for an approved call, plain otherwise. */
const changedAnswer = (ctx: McpToolContext) =>
  ctx.confirmation ? staleAnswer(plainError) : plainError(SCHEDULE_CHANGED);

function serviceFailure(tool: string, error: unknown) {
  logger.error("MCP schedule tool failed", {
    tool,
    error: error instanceof Error ? `${tool}: ${error.message}` : `${tool}: ${String(error)}`,
  });
  return plainError(CHANGE_FAILED);
}

export const schedulesWriteTools: McpToolDefinition[] = [
  defineWriteTool({
    name: "create_schedule",
    title: "Create Schedule",
    description:
      "Create a schedule that triggers a scheduled task (one defined with schedules.task) on a cron, in this environment only. It is active at once and starts runs on its own until it is deactivated or deleted. Outside development environments it counts toward the project's schedule limit.",
    shape: CreateScheduleInput.shape,
    approval: "configurable",
    auth,
    confirm: { preview: planPreview(createPlan) },
    run: (input, ctx) =>
      runPlan(input, ctx, createPlan, async (_, environment) => {
        const { UpsertTaskScheduleService } =
          await import("~/v3/services/upsertTaskSchedule.server");
        try {
          const schedule = await new UpsertTaskScheduleService().call(
            environment.projectId,
            {
              taskIdentifier: input.taskId,
              cron: input.cron,
              timezone: input.timezone,
              externalId: input.externalId,
              deduplicationKey: input.deduplicationKey,
              window: input.window,
              environments: [environment.id],
            },
            { runTokenEnvironmentId: environment.id, createOnly: true }
          );
          return textResult(
            `Created schedule ${scheduleId(schedule.id)}. It is active; its next run is at ${schedule.nextRun.toISOString()} and starts at ${schedule.nextRunEffectiveAt.toISOString()}.`
          );
        } catch (error) {
          if (error instanceof ServiceValidationError && error.status === 409) {
            return plainError(KEY_NOW_TAKEN);
          }
          return upsertFailure(error, undefined);
        }
      }),
  }),
  defineWriteTool({
    name: "update_schedule",
    title: "Update Schedule",
    description:
      "Change an imperative schedule's cron, timezone, external ID or window. Omitted fields keep their values. Declarative schedules (defined in code) and schedules that also run in another environment can't be changed here.",
    shape: UpdateScheduleInput.shape,
    approval: "configurable",
    auth,
    confirm: { preview: planPreview(updatePlan) },
    run: (input, ctx) =>
      runPlan(input, ctx, updatePlan, async ({ schedule, values }, environment) => {
        const { UpsertTaskScheduleService } =
          await import("~/v3/services/upsertTaskSchedule.server");
        try {
          const updated = await new UpsertTaskScheduleService().call(
            environment.projectId,
            {
              friendlyId: schedule.friendlyId,
              taskIdentifier: schedule.taskIdentifier,
              cron: values.cron,
              timezone: values.timezone,
              externalId: values.externalId ?? undefined,
              window: values.window,
              environments: [environment.id],
            },
            { runTokenEnvironmentId: environment.id, revision: schedule.updatedAt }
          );
          return textResult(
            `Updated schedule ${scheduleId(updated.id)}.${
              updated.active ? ` Its next run is at ${updated.nextRun.toISOString()}.` : ""
            }`
          );
        } catch (error) {
          if (error instanceof ServiceValidationError && error.status === 409) {
            return changedAnswer(ctx);
          }
          return upsertFailure(error, schedule.friendlyId);
        }
      }),
  }),
  ...([true, false] as const).map((active) =>
    defineWriteTool({
      name: active ? "activate_schedule" : "deactivate_schedule",
      title: active ? "Activate Schedule" : "Deactivate Schedule",
      description: active
        ? "Activate an inactive imperative schedule so it starts triggering runs again at its next fire time. Missed fire times are not run."
        : "Deactivate an imperative schedule so it triggers no runs until it is activated again. Runs it already triggered are not affected.",
      shape: ScheduleIdInput.shape,
      approval: "configurable",
      auth,
      confirm: {
        preview: planPreview((args: { scheduleId: string }, environment, anchor, read) =>
          activePlan(args, environment, anchor, active, read)
        ),
      },
      run: (input, ctx) =>
        runPlan(
          input,
          ctx,
          (args, environment, anchor, read) => activePlan(args, environment, anchor, active, read),
          async (schedule, environment) => {
            const changed = await lockedChange(
              environment,
              schedule.friendlyId,
              schedule.updatedAt,
              (tx) =>
                new SetActiveOnTaskScheduleService(tx).call({
                  projectId: environment.projectId,
                  userId: ctx.identity.userId,
                  friendlyId: schedule.friendlyId,
                  active,
                })
            ).catch((error: unknown) => ({ failed: error }));
            if (typeof changed === "object") {
              return serviceFailure(
                active ? "activate_schedule" : "deactivate_schedule",
                changed.failed
              );
            }
            if (changed === "gone") return plainError(notOnlyHere(schedule.friendlyId));
            if (changed === "stale") return changedAnswer(ctx);
            return textResult(
              `${active ? "Activated" : "Deactivated"} schedule ${scheduleId(schedule.friendlyId)}.`
            );
          }
        ),
    })
  ),
  defineWriteTool({
    name: "delete_schedule",
    title: "Delete Schedule",
    description:
      "Delete an imperative schedule permanently so it triggers no more runs. Runs it already triggered are kept. Declarative schedules (defined in code) are removed by deleting them from code and deploying.",
    shape: ScheduleIdInput.shape,
    approval: "required",
    auth,
    confirm: {
      preview: planPreview((args: { scheduleId: string }, e, _anchor, read) =>
        deletePlan(args, e, read)
      ),
    },
    run: (input, ctx) =>
      runPlan(
        input,
        ctx,
        (args, environment, _anchor, read) => deletePlan(args, environment, read),
        async (schedule, environment) => {
          const changed = await lockedChange(
            environment,
            schedule.friendlyId,
            schedule.updatedAt,
            (tx) =>
              new DeleteTaskScheduleService(tx).call({
                projectId: environment.projectId,
                userId: ctx.identity.userId,
                friendlyId: schedule.friendlyId,
              })
          ).catch((error: unknown) => ({ failed: error }));
          if (typeof changed === "object") return serviceFailure("delete_schedule", changed.failed);
          if (changed === "gone") return plainError(notOnlyHere(schedule.friendlyId));
          if (changed === "stale") return changedAnswer(ctx);
          return textResult(`Deleted schedule ${scheduleId(schedule.friendlyId)}.`);
        }
      ),
  }),
];
