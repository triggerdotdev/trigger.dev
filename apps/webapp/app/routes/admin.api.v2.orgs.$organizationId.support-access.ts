import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { requireAdminDashboardEnabled } from "~/models/admin.server";
import { requireUser } from "~/services/session.server";
import { SupportAccessService } from "~/services/supportAccess.server";
import { organizationSupportAccessPath } from "~/utils/pathBuilder";
import { pendingRequestCutoff } from "~/utils/supportAccess";

const ParamsSchema = z.object({ organizationId: z.string() });
const FormSchema = z.object({ reason: z.string() });

export type SupportAccessDialogData = {
  pending: { id: string; reason: string; requestedBy: string; createdAt: string }[];
};

export type SupportAccessDialogActionData =
  | { success: true; link: string }
  | { success: false; error: string };

async function requireAdmin(request: Request) {
  requireAdminDashboardEnabled();
  const user = await requireUser(request);
  if (!user.admin) {
    throw new Response("Unauthorized", { status: 403 });
  }
  return user;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireAdmin(request);
  const { organizationId } = ParamsSchema.parse(params);

  const pending = await $replica.supportAccessRequest.findMany({
    where: { organizationId, status: "PENDING", createdAt: { gt: pendingRequestCutoff() } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      reason: true,
      createdAt: true,
      requestedBy: { select: { email: true } },
    },
  });

  return json<SupportAccessDialogData>({
    pending: pending.map((r) => ({
      id: r.id,
      reason: r.reason,
      requestedBy: r.requestedBy?.email ?? "Former Trigger.dev staff",
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

const ERROR_MESSAGES = {
  reason_required: "Add a reason so the org's admins know why you need access.",
  org_not_found: "Organization not found.",
  org_allows_access: "This organization allows Support Access, so no request is needed.",
  other: "Something went wrong creating the request.",
} as const;

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireAdmin(request);
  const { organizationId } = ParamsSchema.parse(params);
  const form = FormSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!form.success) {
    return json<SupportAccessDialogActionData>(
      { success: false, error: ERROR_MESSAGES.reason_required },
      { status: 400 }
    );
  }

  const result = await new SupportAccessService(prisma)
    .createRequest({ organizationId, requestedById: user.id, reason: form.data.reason })
    .map(
      (created) =>
        `${env.PUBLIC_APP_ORIGIN ?? env.APP_ORIGIN}${organizationSupportAccessPath(created.organization)}`
    );

  if (result.isErr()) {
    return json<SupportAccessDialogActionData>(
      { success: false, error: ERROR_MESSAGES[result.error.type] },
      { status: result.error.type === "other" ? 500 : 400 }
    );
  }

  return json<SupportAccessDialogActionData>({ success: true, link: result.value });
}
