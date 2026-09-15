import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { OrganizationParamsSchema, organizationProjectsPath } from "~/utils/pathBuilder";

// The Projects settings page used to live at `/settings/runtime-updates`. Keep the old URL working
// for links that were already shared.
export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  const { search } = new URL(request.url);
  return redirect(`${organizationProjectsPath({ slug: organizationSlug })}${search}`);
};
