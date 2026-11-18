import { Form, useNavigation, useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import { typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextArea } from "~/components/primitives/TextArea";
import { environmentEncryptionBackfill } from "~/services/environmentEncryption/backfillInstance.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { adminWorker } from "~/v3/services/adminWorker.server";

export const loader = dashboardLoader({ authorization: { requireSuper: true } }, async () =>
  typedjson({ job: await environmentEncryptionBackfill.current() })
);

const ActionSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("stop"), jobId: z.string().min(1) }),
  z.object({
    intent: z.enum(["inspect", "enroll", "migrate", "verify"]),
    organizationIds: z.string().min(1).max(10_000),
    backupConfirmed: z.string().optional(),
  }),
]);

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request, user }) => {
    const parsed = ActionSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return typedjson({ error: "Invalid cohort or action" }, { status: 400 });
    const data = parsed.data;
    if (data.intent === "stop") {
      await environmentEncryptionBackfill.stop(data.jobId);
      return typedjson({ error: null });
    }
    if ((data.intent === "enroll" || data.intent === "migrate") && data.backupConfirmed !== "on") {
      return typedjson(
        { error: "Confirm the backup/restore procedure before making changes" },
        { status: 400 }
      );
    }
    try {
      const job = await environmentEncryptionBackfill.create(
        data.intent,
        data.organizationIds.split(","),
        user.id
      );
      try {
        await adminWorker.enqueue({
          id: job.id,
          job: "admin.environmentEncryptionBackfill",
          payload: { jobId: job.id },
        });
      } catch {
        await environmentEncryptionBackfill.enqueueFailed(job.id);
        return typedjson({ error: "Could not enqueue job. Retry the operation." }, { status: 503 });
      }
      return typedjson({ error: null });
    } catch (error) {
      return typedjson(
        { error: error instanceof Error ? error.message : "Could not start job" },
        { status: 400 }
      );
    }
  }
);

export default function EnvironmentEncryptionAdmin() {
  const { job } = useTypedLoaderData<typeof loader>();
  const actionData = useTypedActionData<typeof action>();
  const navigation = useNavigation();
  const { revalidate } = useRevalidator();
  const active = job?.status === "queued" || job?.status === "running";
  const busy = navigation.state !== "idle";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(revalidate, 3_000);
    return () => clearInterval(timer);
  }, [active, revalidate]);

  const totals = job?.environments.reduce(
    (sum, environment) => ({
      scanned: sum.scanned + (environment.progress?.scanned ?? 0),
      rewritten: sum.rewritten + (environment.progress?.rewritten ?? 0),
      remaining: sum.remaining + (environment.progress?.remaining ?? 0),
      conflicts: sum.conflicts + (environment.progress?.conflicts ?? 0),
    }),
    { scanned: 0, rewritten: 0, remaining: 0, conflicts: 0 }
  );

  return (
    <main className="h-full overflow-auto p-4">
      <div className="space-y-4">
        <Header1>Environment encryption migration</Header1>
        <Callout variant="warning">
          Temporary migration tool. Start with small internal orgs. Inspect, confirm backup/restore,
          enroll, migrate, then verify and observe before expanding. Migration overwrites
          ciphertext; the old keyring alone cannot undo it. Flags do not downgrade enrolled
          environments.
        </Callout>
        <Paragraph variant="small">
          One cohort job at a time, one environment at a time, 25 values per batch with a 1-second
          pause. All environments (including archived/preview environments) and retained build
          envelopes are included. Inspect and Verify decrypt without writing. Verify uses this
          worker's key cache, so also check a cold serving process operationally.
        </Paragraph>
        <Form method="post" className="max-w-3xl space-y-3">
          <label htmlFor="organizationIds" className="block text-sm">
            Comma-separated organization IDs (maximum 50)
            <TextArea
              key={job?.id ?? "new"}
              id="organizationIds"
              name="organizationIds"
              required
              rows={3}
              defaultValue={job?.organizations.map((org) => org.id).join(", ")}
              disabled={active || busy}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="backupConfirmed" disabled={active || busy} />
            Backup and restore procedure confirmed (required for Enroll/Migrate)
          </label>
          <div className="flex gap-2">
            {(["inspect", "enroll", "migrate", "verify"] as const).map((intent) => (
              <Button
                key={intent}
                type="submit"
                name="intent"
                value={intent}
                variant="secondary/small"
                disabled={active || busy}
              >
                {
                  {
                    inspect: "Inspect",
                    enroll: "Enroll missing",
                    migrate: "Migrate all",
                    verify: "Verify",
                  }[intent]
                }
              </Button>
            ))}
          </div>
        </Form>
        {actionData?.error && <Callout variant="error">{actionData.error}</Callout>}
        {job && (
          <>
            <div className="flex items-center gap-3">
              <Header2>
                {job.operation}: {job.status}
              </Header2>
              <Button variant="tertiary/small" onClick={revalidate}>
                Refresh
              </Button>
              {active && (
                <Form method="post">
                  <input type="hidden" name="jobId" value={job.id} />
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
              Job {job.id}, requested by {job.actorId}, last update {job.updatedAt}. Retry a
              stopped/failed job by submitting the same operation again; it rescans and skips
              migrated values. Only the latest job is shown. New environments created after
              submission need another pass.
            </Paragraph>
            <div className="space-y-1 text-sm">
              {job.organizations.map((org) => (
                <p key={org.id}>
                  {org.title}: <code>{org.id}</code>
                </p>
              ))}
            </div>
            {job.error && <Callout variant="error">{job.error}</Callout>}
            {totals && (
              <Paragraph variant="small">
                Scanned {totals.scanned}; rewritten {totals.rewritten}; needing migration{" "}
                {totals.remaining}; conflicts {totals.conflicts}. Counts cover scanned rows only,
                not a live snapshot.
              </Paragraph>
            )}
            {job.status === "completed" && job.operation === "migrate" && (
              <Callout variant="warning">
                Run Verify from the beginning before considering this cohort migrated.
              </Callout>
            )}
            {job.status === "completed" && job.operation === "verify" && (
              <Callout variant={totals?.remaining ? "warning" : "success"}>
                {totals?.remaining
                  ? "Values still need migration. Resolve conflicts and repeat."
                  : "All scanned values decrypt and use their environment's active key."}
              </Callout>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Environment</TableHeaderCell>
                  <TableHeaderCell>Status / active key</TableHeaderCell>
                  <TableHeaderCell>Wrapping</TableHeaderCell>
                  <TableHeaderCell>Runtime / build scanned</TableHeaderCell>
                  <TableHeaderCell>Rewritten / remaining / conflicts</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {job.environments.map((environment) => (
                  <TableRow key={environment.id}>
                    <TableCell>
                      {environment.label}
                      <br />
                      <code>{environment.id}</code>
                      <br />
                      <code>{environment.organizationId}</code>
                    </TableCell>
                    <TableCell>
                      {environment.status}
                      <br />
                      <code>{environment.activeKeyId ?? "Not enrolled"}</code>
                    </TableCell>
                    <TableCell>
                      {environment.wrappingProvider ?? "None"}
                      <br />
                      <code>{environment.wrappingKeyReference}</code>
                    </TableCell>
                    <TableCell>
                      {environment.progress
                        ? `${environment.progress.runtimeValues} / ${environment.progress.buildEnvelopes}`
                        : "Not scanned"}
                    </TableCell>
                    <TableCell>
                      {environment.progress
                        ? `${environment.progress.rewritten} / ${environment.progress.remaining} / ${environment.progress.conflicts}`
                        : "Not scanned"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </div>
    </main>
  );
}
