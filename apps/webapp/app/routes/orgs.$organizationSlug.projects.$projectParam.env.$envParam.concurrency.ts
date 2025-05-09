import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { EnvironmentParamSchema, v3QueuesPath } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  return redirect(
    v3QueuesPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam })
  );
};
