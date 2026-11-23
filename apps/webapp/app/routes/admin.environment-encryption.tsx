import { Form, useNavigation } from "@remix-run/react";
import { useEffect } from "react";
import {
  typedjson,
  useTypedActionData,
  useTypedFetcher,
  useTypedLoaderData,
} from "remix-typedjson";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextArea } from "~/components/primitives/TextArea";
import type { FleetOperation } from "~/services/environmentEncryption/backfill.server";
import { environmentEncryptionBackfill } from "~/services/environmentEncryption/backfillInstance.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { adminWorker } from "~/v3/services/adminWorker.server";

const LEGACY_PAGE_ID = "legacy";
const STATUS_QUERY = "?status";
const operations = ["inspect", "enroll", "migrate", "verify"] as const;
const operationLabels = {
  inspect: "Inspect",
  enroll: "Enroll missing",
  migrate: "Migrate",
  verify: "Verify",
};
const fleetOperations = ["enroll", "migrate"] as const;
const fleetPhrases = {
  enroll: "ENROLL ALL",
  migrate: "MIGRATE ALL",
};

export const loader = dashboardLoader(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    const statusOnly = new URL(request.url).searchParams.has("status");
    const [job, verified, page] = await Promise.all([
      environmentEncryptionBackfill.current(),
      environmentEncryptionBackfill.pageVerified(),
      statusOnly ? null : environmentEncryptionBackfill.page(),
    ]);
    return typedjson({
      job,
      verified,
      page: page && {
        id: page.id,
        number: page.number,
        fleetOperation: page.fleetOperation,
        organizations: page.organizations,
        count: page.environments.length,
        first: page.environments.at(0) ?? null,
        last: page.environments.at(-1) ?? null,
        after: page.after,
        hasNext: page.nextCursor !== null,
      },
    });
  }
);

const fleetConfirmation = {
  backupConfirmed: z.literal("on"),
  monitoringConfirmed: z.literal("on"),
  scopeConfirmed: z.literal("on"),
  confirmation: z.string(),
};

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("startFleet"),
    operation: z.enum(fleetOperations),
    pageId: z.string(),
    ...fleetConfirmation,
  }),
  z.object({
    intent: z.literal("resumeFleet"),
    jobId: z.string().min(1),
    ...fleetConfirmation,
  }),
  z.object({
    intent: z.literal("select"),
    pageId: z.string(),
    organizationIds: z.string().min(1).max(10_000),
  }),
  z.object({ intent: z.literal("next"), pageId: z.string().min(1) }),
  z.object({ intent: z.literal("stop"), pageId: z.string().min(1), jobId: z.string().min(1) }),
  z.object({
    intent: z.enum(operations),
    pageId: z.string().min(1),
    backupConfirmed: z.string().optional(),
  }),
]);

async function enqueueJob(jobId: string, fleet = false) {
  try {
    await adminWorker.enqueue({
      id: jobId,
      job: fleet ? "admin.environmentEncryptionFleet" : "admin.environmentEncryptionBackfillPage",
      payload: { jobId },
    });
  } catch {
    await environmentEncryptionBackfill.enqueueFailed(jobId);
    return typedjson(
      {
        error: fleet
          ? "Could not enqueue job. Refresh status and resume the fleet pass."
          : "Could not enqueue job. Retry the operation.",
      },
      { status: 503 }
    );
  }
  return typedjson({ error: null });
}

function confirmFleet(confirmation: string, operation: FleetOperation) {
  if (confirmation !== fleetPhrases[operation]) {
    throw new Error(`Type ${fleetPhrases[operation]} exactly to confirm.`);
  }
}

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request, user }) => {
    const form = Object.fromEntries(await request.formData());
    const parsed = ActionSchema.safeParse(form);
    if (!parsed.success) {
      const fleet = form.intent === "startFleet" || form.intent === "resumeFleet";
      return typedjson(
        {
          error: fleet
            ? "Confirm backup/restore, monitoring and fleet scope, and enter the confirmation phrase."
            : "Invalid cohort or action",
        },
        { status: 400 }
      );
    }
    const data = parsed.data;
    try {
      switch (data.intent) {
        case "startFleet": {
          confirmFleet(data.confirmation, data.operation);
          const job = await environmentEncryptionBackfill.createFleet(
            data.operation,
            user.id,
            data.pageId
          );
          return await enqueueJob(job.id, true);
        }
        case "resumeFleet": {
          const current = await environmentEncryptionBackfill.current();
          if (
            !current?.fleet ||
            current.id !== data.jobId ||
            (current.operation !== "enroll" && current.operation !== "migrate")
          ) {
            throw new Error("Fleet job changed. Refresh and try again.");
          }
          confirmFleet(data.confirmation, current.operation);
          const job = await environmentEncryptionBackfill.resumeFleet(data.jobId, user.id);
          return await enqueueJob(job.id, true);
        }
        case "select": {
          await environmentEncryptionBackfill.selectPage(
            data.organizationIds.split(","),
            data.pageId
          );
          return typedjson({ error: null });
        }
        case "next":
          await environmentEncryptionBackfill.nextPage(data.pageId);
          return typedjson({ error: null });
        case "stop": {
          const job = await environmentEncryptionBackfill.current();
          if (job?.id !== data.jobId || (!job.fleet && job.pageId !== data.pageId)) {
            throw new Error("The job changed. Reload and try again.");
          }
          await environmentEncryptionBackfill.stop(data.jobId);
          return typedjson({ error: null });
        }
      }
      if (
        (data.intent === "enroll" || data.intent === "migrate") &&
        data.backupConfirmed !== "on"
      ) {
        return typedjson(
          { error: "Confirm the backup/restore procedure before making changes" },
          { status: 400 }
        );
      }
      const job = await environmentEncryptionBackfill.create(data.intent, data.pageId, user.id);
      return await enqueueJob(job.id);
    } catch (error) {
      return typedjson(
        { error: error instanceof Error ? error.message : "Could not apply action" },
        { status: 400 }
      );
    }
  }
);

export default function EnvironmentEncryptionAdmin() {
  const data = useTypedLoaderData<typeof loader>();
  return (
    <MigrationPage key={`${data.page?.id}:${data.job?.id}:${data.job?.updatedAt}`} data={data} />
  );
}

function MigrationPage({ data }: { data: ReturnType<typeof useTypedLoaderData<typeof loader>> }) {
  const { page: initialPage } = data;
  const actionData = useTypedActionData<typeof action>();
  const navigation = useNavigation();
  const { data: status, load, state } = useTypedFetcher<typeof loader>();
  const { job, verified } = status ?? data;
  const active = job?.status === "queued" || job?.status === "running";
  const busy = navigation.state !== "idle";
  const legacy = !initialPage && job?.pageId === LEGACY_PAGE_ID;
  const page = !initialPage?.fleetOperation && !job?.fleet ? initialPage : null;
  const expectedPageId = job?.fleet ? job.pageId : (initialPage?.id ?? "");
  const pageJob = page && job?.pageId === page.id ? job : null;
  const fleetOperation =
    job?.fleet && (job.operation === "enroll" || job.operation === "migrate")
      ? job.operation
      : null;
  const resumable = fleetOperation && (job?.status === "stopped" || job?.status === "failed");
  const pageVerified =
    verified &&
    pageJob?.operation === "verify" &&
    pageJob.id === data.job?.id &&
    pageJob.status === "completed" &&
    pageJob.progress.remaining === 0;

  useEffect(() => {
    if (!active || busy || state !== "idle") return;
    const timer = setTimeout(() => load(STATUS_QUERY), 3_000);
    return () => clearTimeout(timer);
  }, [active, busy, state, load]);

  return (
    <main className="h-full overflow-auto p-4">
      <div className="max-w-4xl space-y-4">
        <Header1>Environment encryption migration</Header1>
        <Callout variant="warning">
          Temporary migration tool. Start with small internal orgs. Inspect, confirm backup/restore,
          enroll, migrate, then verify and observe. Migration overwrites ciphertext; the old keyring
          alone cannot undo it. Flags do not downgrade enrolled environments.
        </Callout>
        <Paragraph variant="small">
          Each page fixes up to 1,000 environments for all four operations, including archived and
          preview environments. One job runs globally, one environment at a time. Enrollment pauses
          100 ms per environment; scans pause 100 ms between batches of 25 with no extra environment
          pause. Inspect and Verify decrypt without writing. Check cold serving-process access
          separately.
        </Paragraph>
        <Form method="post" className="space-y-2">
          <input type="hidden" name="pageId" value={expectedPageId} />
          <label htmlFor="organizationIds" className="block text-sm">
            Comma-separated organization IDs (maximum 50)
            <TextArea
              id="organizationIds"
              name="organizationIds"
              required
              rows={2}
              defaultValue={page?.organizations.map((org) => org.id).join(", ")}
              disabled={active || busy}
            />
          </label>
          <Button
            type="submit"
            name="intent"
            value="select"
            variant="secondary/small"
            disabled={active || busy}
          >
            Select cohort{page && " (starts at page 1)"}
          </Button>
          {resumable && (
            <Paragraph variant="small">
              Selecting a manual cohort discards the saved fleet checkpoint. Use Resume fleet to
              keep it.
            </Paragraph>
          )}
        </Form>
        {actionData?.error && <Callout variant="error">{actionData.error}</Callout>}
        {legacy && (
          <Callout variant="warning">
            This job predates fixed pages. It has no page scope or progress summary. Stop it if
            still active, then select a cohort and inspect again.
          </Callout>
        )}
        {page && (
          <>
            <Header2>
              Page {page.number}: {page.count} environments
            </Header2>
            <Paragraph variant="small">
              Organizations: {page.organizations.map((org) => org.title).join(", ")}.
            </Paragraph>
            {page.after && (
              <Paragraph variant="small">
                After checkpoint:{" "}
                <code>
                  {page.after.organizationId} / {page.after.environmentId}
                </code>
              </Paragraph>
            )}
            {page.first && page.last && (
              <Paragraph variant="small">
                First: {page.first.label} (
                <code>
                  {page.first.organizationId} / {page.first.id}
                </code>
                ). Last: {page.last.label} (
                <code>
                  {page.last.organizationId} / {page.last.id}
                </code>
                ).
              </Paragraph>
            )}
            <Form method="post" className="space-y-3">
              <input type="hidden" name="pageId" value={page.id} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="backupConfirmed" disabled={active || busy} />
                Backup and restore procedure confirmed (required for Enroll/Migrate)
              </label>
              <div className="flex flex-wrap gap-2">
                {operations.map((intent) => (
                  <Button
                    key={intent}
                    type="submit"
                    name="intent"
                    value={intent}
                    variant="secondary/small"
                    disabled={active || busy}
                  >
                    {operationLabels[intent]}
                  </Button>
                ))}
                <Button
                  type="submit"
                  name="intent"
                  value="next"
                  variant="primary/small"
                  disabled={!pageVerified || !page.hasNext || active || busy}
                >
                  Next page
                </Button>
              </div>
            </Form>
            {verified && pageJob && pageJob.id !== data.job?.id && (
              <Callout variant="warning">Reload to use the latest Verify result.</Callout>
            )}
            {pageVerified && (
              <Callout variant="success">
                Page verified for stored values. Empty environments may still be unenrolled.
                {!page.hasNext &&
                  " Selected organizations exhausted as of the page selection scan."}
              </Callout>
            )}
          </>
        )}
        {job && (job.fleet || pageJob || legacy || active) && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Header2>
                {fleetOperation
                  ? `Fleet ${fleetPhrases[fleetOperation]}`
                  : operationLabels[job.operation]}
                : {job.status}
              </Header2>
              <Button
                variant="tertiary/small"
                disabled={busy || state !== "idle"}
                onClick={() => load(STATUS_QUERY)}
              >
                Refresh status
              </Button>
              {active && (
                <Form method="post">
                  <input type="hidden" name="jobId" value={job.id} />
                  <input type="hidden" name="pageId" value={job.pageId} />
                  <Button
                    type="submit"
                    name="intent"
                    value="stop"
                    variant="danger/small"
                    disabled={busy}
                  >
                    Stop after current batch
                  </Button>
                </Form>
              )}
            </div>
            <Paragraph variant="small">
              Job {job.id}, requested by {job.actorId}, last update {job.updatedAt}.
            </Paragraph>
            {active && !job.fleet && !pageJob && !legacy && (
              <Callout variant="warning">
                Another page has an active job. Reload to see its scope.
              </Callout>
            )}
            {!legacy && job.error && <Callout variant="error">{job.error}</Callout>}
          </>
        )}
        {job?.fleet && <FleetProgress job={job} fleet={job.fleet} />}
        {resumable && fleetOperation && job && (
          <details className="space-y-3 rounded border border-grid-dimmed p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Resume fleet {fleetPhrases[fleetOperation]}
            </summary>
            <Callout variant="warning">
              Resuming restarts apply on the current page across the same global scope and keeps
              completed page checkpoints. Writes already made are not undone.
            </Callout>
            <FleetConfirmationForm
              key={job.id}
              operation={fleetOperation}
              disabled={busy}
              resumeJobId={job.id}
            />
          </details>
        )}
        {page && pageJob && (
          <>
            <Paragraph variant="small">
              Processed {pageJob.completedEnvironments} / {page.count} environments. Enrolled{" "}
              {pageJob.enrolledEnvironments}; KMS-wrapped {pageJob.kmsEnvironments}; keyring-wrapped{" "}
              {pageJob.keyringEnvironments}.
            </Paragraph>
            {pageJob.currentEnvironment && (
              <Paragraph variant="small">
                Current: {pageJob.currentEnvironment.label} (
                <code>{pageJob.currentEnvironment.id}</code>). Active key:{" "}
                <code>{pageJob.currentEnvironment.activeKeyId ?? "Not enrolled"}</code>. Wrapping:{" "}
                {pageJob.currentEnvironment.wrappingProvider ?? "None"}{" "}
                <code>{pageJob.currentEnvironment.wrappingKeyReference}</code>
              </Paragraph>
            )}
            {(pageJob.status === "stopped" || pageJob.status === "failed") && (
              <Paragraph variant="small">To retry, run the operation again on this page.</Paragraph>
            )}
            {pageJob.operation !== "enroll" && (
              <Paragraph variant="small">
                Scanned {pageJob.progress.scanned} ({pageJob.progress.runtimeValues} runtime /{" "}
                {pageJob.progress.buildEnvelopes} build); rewritten {pageJob.progress.rewritten};
                needing migration {pageJob.progress.remaining}; conflicts{" "}
                {pageJob.progress.conflicts}. Counts describe the scan, not a live snapshot.
              </Paragraph>
            )}
            {pageJob.status === "completed" && pageJob.operation === "migrate" && (
              <Callout variant="warning">Run Verify on this page before advancing.</Callout>
            )}
            {pageJob.status === "completed" &&
              pageJob.operation === "verify" &&
              pageJob.progress.remaining > 0 && (
                <Callout variant="warning">
                  Values still need migration. Resolve conflicts and repeat on this page.
                </Callout>
              )}
          </>
        )}
        <details className="space-y-3 rounded border border-grid-dimmed p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Danger zone: start a global fleet pass
          </summary>
          <Callout variant="warning">
            Fleet operations affect all eligible organizations, not the selected cohort. They
            include archived, development and preview environments. Only one job runs globally. A
            new pass replaces the current page and any saved fleet checkpoint.
          </Callout>
          <Paragraph variant="small">
            The admin worker advances automatically in pages of up to 1,000 environments. No browser
            or CLI is needed after starting. Start with a manual canary and monitor the database,
            KMS and serving errors throughout the pass.
          </Paragraph>
          <details className="space-y-2">
            <summary className="cursor-pointer text-sm font-medium">ENROLL ALL</summary>
            <Paragraph variant="small">
              Create keys only for unenrolled environments. Explicit organization opt-outs are
              skipped; other enrollment gate failures stop the pass. Enrollment changes future
              writes. Turning flags off does not undo it. This does not migrate stored values.
            </Paragraph>
            <FleetConfirmationForm
              key={expectedPageId}
              operation="enroll"
              disabled={active || busy}
              pageId={expectedPageId}
            />
          </details>
          <details className="space-y-2">
            <summary className="cursor-pointer text-sm font-medium">MIGRATE ALL</summary>
            <Paragraph variant="small">
              Scan all enrolled environments and verify each page before advancing. Review
              enrollment results and exclusions first: this does not enroll missing environments.
              Rewrites runtime variables and retained build envelopes only, not platform or billing
              secrets. Migration overwrites ciphertext and cannot be undone with the old keyring
              alone. Neither pass rotates or retires keys.
            </Paragraph>
            <FleetConfirmationForm
              key={expectedPageId}
              operation="migrate"
              disabled={active || busy}
              pageId={expectedPageId}
            />
          </details>
        </details>
      </div>
    </main>
  );
}

type Job = NonNullable<ReturnType<typeof useTypedLoaderData<typeof loader>>["job"]>;

function FleetProgress({ job, fleet }: { job: Job; fleet: NonNullable<Job["fleet"]> }) {
  const applyProgress = fleet.phase === "verify" ? fleet.pageProgress : job.progress;
  return (
    <>
      <Paragraph variant="small">
        Completed pages: {fleet.completedPages}; environments: {fleet.completedEnvironments};
        skipped: {fleet.skippedEnvironments} (explicit enrollment opt-outs or confirmed deletions).
        {job.operation === "migrate" && (
          <>
            {" "}
            Rewritten: {fleet.rewritten}; conflicts: {fleet.conflicts}.
          </>
        )}{" "}
        Upper environment ID: <code>{fleet.throughEnvironmentId ?? "None"}</code>.
      </Paragraph>
      {job.status !== "completed" && (
        <>
          <Paragraph variant="small">
            Page {fleet.pageNumber}, {fleet.phase}: {job.completedEnvironments} / {fleet.pageSize}{" "}
            environments processed in this phase; skipped: {job.skippedEnvironments}.
          </Paragraph>
          {job.currentEnvironment && (
            <Paragraph variant="small">
              Current: {job.currentEnvironment.label} (<code>{job.currentEnvironment.id}</code>).
              Wrapping: {job.currentEnvironment.wrappingProvider ?? "None"}{" "}
              <code>{job.currentEnvironment.wrappingKeyReference}</code>.
            </Paragraph>
          )}
          {job.operation === "migrate" && (
            <Paragraph variant="small">
              Page apply: scanned {applyProgress.scanned}; rewritten {applyProgress.rewritten};
              conflicts {applyProgress.conflicts}.
              {fleet.phase === "verify" && (
                <>
                  {" "}
                  Page verify: scanned {job.progress.scanned}; needing migration{" "}
                  {job.progress.remaining}.
                </>
              )}
            </Paragraph>
          )}
        </>
      )}
    </>
  );
}

function FleetConfirmationForm({
  operation,
  disabled,
  ...target
}: {
  operation: FleetOperation;
  disabled: boolean;
} & ({ pageId: string } | { resumeJobId: string })) {
  const resume = "resumeJobId" in target;
  const phrase = fleetPhrases[operation];
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={resume ? "resumeFleet" : "startFleet"} />
      {resume ? (
        <input type="hidden" name="jobId" value={target.resumeJobId} />
      ) : (
        <>
          <input type="hidden" name="operation" value={operation} />
          <input type="hidden" name="pageId" value={target.pageId} />
        </>
      )}
      <fieldset className="space-y-2" disabled={disabled}>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="backupConfirmed" required />
          I confirmed a fresh backup or PITR restore point and a tested restore procedure.
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="monitoringConfirmed" required />
          Monitoring is in place. I will watch database load, KMS and serving failures and stop if
          needed.
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="scopeConfirmed" required />
          I understand this affects all eligible organizations and stopping does not roll back
          writes.
        </label>
        <label className="block text-sm">
          Type <strong>{phrase}</strong> to confirm
          <input
            className="ml-2 rounded border border-grid-dimmed bg-background-bright px-2 py-1"
            name="confirmation"
            pattern={phrase}
            required
            autoComplete="off"
          />
        </label>
        <Button type="submit" variant="danger/small" disabled={disabled}>
          {resume ? "Resume" : "Start"} {phrase}
        </Button>
      </fieldset>
    </Form>
  );
}
