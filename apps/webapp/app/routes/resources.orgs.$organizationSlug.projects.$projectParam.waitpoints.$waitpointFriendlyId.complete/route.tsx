import { parse } from "@conform-to/zod";
import { InformationCircleIcon } from "@heroicons/react/20/solid";
import { Form, useNavigation, useSubmit } from "@remix-run/react";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { Waitpoint } from "@trigger.dev/database";
import { useCallback, useRef } from "react";
import { z } from "zod";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { JSONEditor } from "~/components/code/JSONEditor";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Header3 } from "~/components/primitives/Headers";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3SchedulesPath } from "~/utils/pathBuilder";
import { UpsertSchedule } from "~/v3/schedules";
import { UpsertTaskScheduleService } from "~/v3/services/upsertTaskSchedule.server";

const CompleteWaitpointFormData = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("MANUAL"),
    payload: z.string(),
  }),
  z.object({
    type: z.literal("DATETIME"),
  }),
]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: UpsertSchedule });

  if (!submission.value) {
    return json(submission);
  }

  try {
    //first check that the user has access to the project
    const project = await prisma.project.findUnique({
      where: {
        slug: projectParam,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
      select: { id: true },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    const createSchedule = new UpsertTaskScheduleService();
    const result = await createSchedule.call(project.id, submission.value);

    return redirectWithSuccessMessage(
      v3SchedulesPath({ slug: organizationSlug }, { slug: projectParam }),
      request,
      submission.value?.friendlyId === result.id ? "Schedule updated" : "Schedule created"
    );
  } catch (error: any) {
    logger.error("Failed to create schedule", error);

    const errorMessage = `Something went wrong. Please try again.`;
    return redirectWithErrorMessage(
      v3SchedulesPath({ slug: organizationSlug }, { slug: projectParam }),
      request,
      errorMessage
    );
  }
};

type FormWaitpoint = Pick<Waitpoint, "friendlyId" | "type">;

export function CompleteWaitpointForm({ waitpoint }: { waitpoint: FormWaitpoint }) {
  const navigation = useNavigation();
  const submit = useSubmit();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const currentJson = useRef<string>("{\n\n}");
  const formAction = `/resources/orgs/${organization.slug}/projects/${project.slug}/waitpoints/${waitpoint.friendlyId}/complete`;

  const submitForm = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      const formData = new FormData(e.currentTarget);
      const data: Record<string, string> = {
        type: formData.get("type") as string,
        failedRedirect: formData.get("failedRedirect") as string,
        successRedirect: formData.get("failedRedirect") as string,
      };

      data.payload = currentJson.current;

      submit(data, {
        action: formAction,
        method: "post",
      });
      e.preventDefault();
    },
    [currentJson]
  );

  return (
    <div className="space-y-3">
      <Form
        action={formAction}
        method="post"
        onSubmit={(e) => submitForm(e)}
        className="grid h-full max-h-full grid-rows-[2.5rem_1fr_2.5rem] overflow-hidden rounded-md border border-grid-bright"
      >
        <div className="mx-3 flex items-center">
          <Paragraph variant="small/bright">Manually complete this waitpoint</Paragraph>
        </div>
        <div className="overflow-y-auto border-t border-grid-dimmed bg-charcoal-900 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
          <input type="hidden" name="type" value={waitpoint.type} />
          <div className="max-h-[70vh] min-h-40 overflow-y-auto bg-charcoal-900 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <JSONEditor
              autoFocus
              defaultValue={currentJson.current}
              readOnly={false}
              basicSetup
              onChange={(v) => {
                currentJson.current = v;
              }}
              showClearButton={false}
              showCopyButton={false}
              height="100%"
              min-height="100%"
              max-height="100%"
            />
          </div>
        </div>
        <div className="bg-charcoal-900 px-2">
          <div className="mb-2 flex items-center justify-end gap-2 border-t border-grid-dimmed pt-2">
            <Button
              variant="secondary/small"
              type="submit"
              disabled={isLoading}
              LeadingIcon={isLoading ? "spinner" : undefined}
            >
              {isLoading ? "Completing…" : "Complete waitpoint"}
            </Button>
          </div>
        </div>
      </Form>
      <CodeBlock
        rowTitle={
          <span className="-ml-1 flex items-center gap-1 text-text-dimmed">
            <InformationCircleIcon className="size-5 shrink-0 text-text-dimmed" />
            To complete this waitpoint in your code use:
          </span>
        }
        code={`
await wait.completeToken<YourType>(tokenId,
  output
);`}
        showLineNumbers={false}
      />
    </div>
  );
}
