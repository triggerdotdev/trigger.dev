import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { EnvironmentParamSchema, v3CustomDashboardPath } from "~/utils/pathBuilder";

const ParamSchema = EnvironmentParamSchema.extend({
  dashboardId: z.string(),
});

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const { organizationSlug, projectParam, envParam, dashboardId } = ParamSchema.parse(params);
  return redirect(
    v3CustomDashboardPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
      { friendlyId: dashboardId }
    ),
    301
  );
};
