import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { isValidDuration } from "~/services/realtime/duration.server";
import {
  isPerOrgBasinsEnabled,
  reconfigureBasinForOrg,
} from "~/services/realtime/streamBasinProvisioner.server";
import { commonWorker } from "~/v3/commonWorker.server";

/**
 * Admin trigger for `v3.reconfigureStreamBasinForOrg`. The plan-change
 * path in `setPlan` enqueues this automatically when billing is wired;
 * this route exists for ops + e2e testing.
 *
 * - Default (`{ orgId }`): enqueues the worker job which resolves the
 *   retention from the org's plan and PATCHes the basin to match.
 *   No-op when billing isn't configured (OSS).
 * - With `retention`: bypasses the billing lookup and runs reconfigure
 *   inline against the given duration string (e.g. `"7d"`, `"30d"`,
 *   `"365d"`, `"1y"`). Useful for validating the PATCH wire shape
 *   end-to-end and as a manual override (e.g. enterprise contracts).
 */
const BodySchema = z
  .object({
    orgId: z.string(),
    retention: z
      .string()
      .refine(isValidDuration, "retention must be a duration like 7d, 30d, 365d, 1h, 1y")
      .optional(),
  })
  .strict();

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  if (!isPerOrgBasinsEnabled()) {
    return json(
      { ok: false, error: "Per-org stream basins are disabled." },
      { status: 400 }
    );
  }

  let parsed: ReturnType<typeof BodySchema.safeParse>;
  try {
    const text = await request.text();
    const raw = text.length > 0 ? JSON.parse(text) : {};
    parsed = BodySchema.safeParse(raw);
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsed.success) {
    return json({ ok: false, error: parsed.error.flatten() }, { status: 400 });
  }

  if (parsed.data.retention) {
    // Direct, synchronous reconfigure with the explicit retention.
    // Skips the worker queue + billing lookup so the PATCH is
    // verifiable in the response. Errors surface as 500.
    await reconfigureBasinForOrg(parsed.data.orgId, parsed.data.retention);
    return json({
      ok: true,
      mode: "inline",
      orgId: parsed.data.orgId,
      retention: parsed.data.retention,
    });
  }

  await commonWorker.enqueue({
    job: "v3.reconcileStreamBasinForOrg",
    payload: { orgId: parsed.data.orgId },
    id: `reconcileStreamBasin:${parsed.data.orgId}`,
  });

  return json({ ok: true, mode: "queued", enqueued: parsed.data.orgId });
}
