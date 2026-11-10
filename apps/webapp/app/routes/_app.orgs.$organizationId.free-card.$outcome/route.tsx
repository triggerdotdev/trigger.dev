import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { parseFreeCardReturnTo } from "~/components/billing/freeCardStepPath";
import { freeCardReturnCookie } from "~/services/freeCardReturnCookie.server";
import { freeCardOutcomeRedirect } from "~/services/freeCardStep.server";
import { requireUserId } from "~/services/session.server";

const ParamsSchema = z.object({
  organizationId: z.string(),
  outcome: z.enum(["complete", "canceled", "failed"]),
});

// Billing sends the user here, by org id, once they leave Stripe's card page.
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) throw new Response(null, { status: 404 });
  const { organizationId, outcome } = parsed.data;

  const organization = await prisma.organization.findFirst({
    select: { slug: true },
    where: { id: organizationId, members: { some: { userId } } },
  });
  if (!organization) throw new Response(null, { status: 404 });

  const reason = new URL(request.url).searchParams.get("reason");
  const returnTo = parseFreeCardReturnTo(
    await freeCardReturnCookie.parse(request.headers.get("cookie"))
  );
  const { path, kind, message } = freeCardOutcomeRedirect(organization, outcome, reason, returnTo);
  const response =
    kind === "success"
      ? await redirectWithSuccessMessage(path, request, message)
      : await redirectWithErrorMessage(path, request, message);
  // A retry goes back through the card step, whose URL carries the return target again.
  response.headers.append("Set-Cookie", await freeCardReturnCookie.serialize("", { maxAge: 0 }));
  return response;
};
