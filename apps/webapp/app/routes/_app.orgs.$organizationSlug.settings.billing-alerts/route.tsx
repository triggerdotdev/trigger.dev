import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { OrganizationParamsSchema, v3BillingLimitsPath } from "~/utils/pathBuilder";

export async function loader({ params }: LoaderFunctionArgs) {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);
  return redirect(v3BillingLimitsPath({ slug: organizationSlug }), 302);
}
