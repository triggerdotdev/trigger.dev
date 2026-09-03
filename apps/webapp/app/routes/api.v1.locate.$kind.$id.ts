import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { isOrganizationMember, locateAgentObject } from "~/services/locateAgentObject.server";
import { logger } from "~/services/logger.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * Deterministic org-wide locator for the Dashboard Agent. The organization comes only from the
 * token's claim, so there is nothing for a caller to point at another tenant.
 */

const ParamsSchema = z.object({
  kind: z.enum(["run", "error"]),
  id: z.string().min(1),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const authentication = await authenticateUatOrApiRequest(request);
  const userActor = authentication?.userActor;

  if (!userActor?.organizationId) {
    return json({ error: "Invalid or missing access token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) {
    return json({ error: "Unknown object kind", code: "invalid_request" }, { status: 400 });
  }

  const organizationId = userActor.organizationId;

  if (!(await isOrganizationMember(organizationId, userActor.userId))) {
    return json(
      { error: "You don't have access to that organization.", code: "forbidden_organization" },
      { status: 403 }
    );
  }

  try {
    return json(
      await locateAgentObject({
        kind: parsedParams.data.kind,
        id: parsedParams.data.id,
        organizationId,
        userId: userActor.userId,
      })
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to locate an object for the dashboard agent", {
      error,
      kind: parsedParams.data.kind,
      organizationId,
    });
    return json({ error: "Internal Server Error", code: "internal" }, { status: 500 });
  }
}
