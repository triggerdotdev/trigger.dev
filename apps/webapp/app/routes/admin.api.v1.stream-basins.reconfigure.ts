import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import {
  isPerOrgBasinsEnabled,
  reconfigureBasinForOrg,
  type StreamBasinTier,
} from "~/services/realtime/streamBasinProvisioner.server";
import { commonWorker } from "~/v3/commonWorker.server";

/**
 * Admin trigger for `v3.reconfigureStreamBasinForOrg`. The plan-change
 * path in `setPlan` already enqueues this automatically in cloud mode;
 * this route exists for ops + e2e testing.
 *
 * - Default (`{ orgId }`): enqueues the worker job which resolves the
 *   tier via `getCurrentPlan` and PATCHes the basin to match. No-op
 *   locally because `getCurrentPlan` is gated to cloud hosts.
 * - With `tier`: bypasses the billing lookup and runs reconfigure
 *   inline against the given tier. Useful for validating the PATCH
 *   wire shape end-to-end and as a manual override (e.g. enterprise
 *   contract retention).
 */
const BodySchema = z
  .object({
    orgId: z.string(),
    tier: z.enum(["free", "hobby", "pro"]).optional(),
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

  if (parsed.data.tier) {
    // Direct, synchronous reconfigure with the explicit tier override.
    // Skips the worker queue + billing lookup so the PATCH is verifiable
    // in the response. Errors surface as 500.
    const tier: StreamBasinTier = parsed.data.tier;
    await reconfigureBasinForOrg(parsed.data.orgId, tier);
    return json({ ok: true, mode: "inline", orgId: parsed.data.orgId, tier });
  }

  await commonWorker.enqueue({
    job: "v3.reconfigureStreamBasinForOrg",
    payload: { orgId: parsed.data.orgId },
    id: `reconfigureStreamBasin:${parsed.data.orgId}`,
  });

  return json({ ok: true, mode: "queued", enqueued: parsed.data.orgId });
}
