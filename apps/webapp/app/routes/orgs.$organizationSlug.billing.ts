import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { OrganizationParamsSchema, v3BillingPath } from "~/utils/pathBuilder";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  return redirect(v3BillingPath({ slug: organizationSlug }));
};
