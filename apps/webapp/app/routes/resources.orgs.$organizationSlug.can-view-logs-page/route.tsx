import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { requireUser } from "~/services/session.server";
import { hasLogsPageAccess } from "~/services/logsAccess.server";
import { OrganizationParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const canViewLogsPage =
    user.admin ||
    user.isImpersonating ||
    (await hasLogsPageAccess(user.id, user.admin, user.isImpersonating, organizationSlug));

  return typedjson({ canViewLogsPage });
};
