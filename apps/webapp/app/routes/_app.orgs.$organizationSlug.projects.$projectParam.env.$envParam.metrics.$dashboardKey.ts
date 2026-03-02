import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { EnvironmentParamSchema, v3BuiltInDashboardPath } from "~/utils/pathBuilder";

const ParamSchema = EnvironmentParamSchema.extend({
  dashboardKey: z.string(),
});

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const { organizationSlug, projectParam, envParam, dashboardKey } = ParamSchema.parse(params);
  return redirect(
    v3BuiltInDashboardPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam },
      dashboardKey
    ),
    301
  );
};
