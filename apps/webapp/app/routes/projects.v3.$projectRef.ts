import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { z } from "zod";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ params, request }: LoaderFunctionArgs) {
  const validatedParams = ParamsSchema.parse(params);

  return redirect(`/projects/${validatedParams.projectRef}`);
}
