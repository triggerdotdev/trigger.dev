import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { type TaskRunListSearchFilters } from "~/components/runs/v3/RunFilters";

const RequestSchema = z.object({
  text: z.string().min(1),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  // Parse the request body
  const formData = await request.formData();
  const submission = RequestSchema.safeParse(Object.fromEntries(formData));

  if (!submission.success) {
    return json<{ success: false; error: string }>(
      {
        success: false,
        error: "Invalid request data",
      },
      { status: 400 }
    );
  }

  const { text } = submission.data;

  // TODO: Replace this with actual AI processing
  // For now, return fake successful data
  const fakeFilters: TaskRunListSearchFilters = {
    statuses: ["COMPLETED_WITH_ERRORS"],
    period: "7d",
    tags: ["test-tag"],
  };

  return json<{ success: true; filters: TaskRunListSearchFilters; explanation: string }>({
    success: true,
    filters: fakeFilters,
    explanation: `Applied filters: failed status, last 7 days, with tag "test-tag"`,
  });
}
