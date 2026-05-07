import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { isValidDuration } from "~/services/realtime/duration.server";
import {
  deprovisionBasinForOrg,
  ensureBasinForOrg,
} from "~/services/realtime/streamBasinProvisioner.server";

const ParamsSchema = z.object({ organizationId: z.string() });

const BodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("ensure"),
    retention: z
      .string()
      .refine(isValidDuration, "retention must be a duration like 7d, 30d, 365d, 1h, 1y"),
  }),
  z.object({ action: z.literal("deprovision") }),
]);

export async function action({ request, params }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  const { organizationId } = ParamsSchema.parse(params);

  let parsed: z.infer<typeof BodySchema>;
  try {
    const text = await request.text();
    const raw = text.length > 0 ? JSON.parse(text) : {};
    const result = BodySchema.safeParse(raw);
    if (!result.success) {
      return json({ ok: false, error: result.error.flatten() }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (parsed.action === "ensure") {
    const result = await ensureBasinForOrg(organizationId, parsed.retention);
    return json({ ok: true, ...result });
  }

  const result = await deprovisionBasinForOrg(organizationId);
  return json({ ok: true, ...result });
}
