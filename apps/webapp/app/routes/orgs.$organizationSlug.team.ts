import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { OrganizationParamsSchema, organizationTeamPath, v3UsagePath } from "~/utils/pathBuilder";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  return redirect(organizationTeamPath({ slug: organizationSlug }));
};
