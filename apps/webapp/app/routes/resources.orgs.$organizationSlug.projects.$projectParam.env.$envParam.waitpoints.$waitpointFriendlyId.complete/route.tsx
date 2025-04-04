import { env } from "~/env.server";
import { parse } from "@conform-to/zod";
import { Form, useLocation, useNavigation, useSubmit } from "@remix-run/react";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  conditionallyExportPacket,
  IOPacket,
  stringifyIO,
  timeoutError,
  WaitpointTokenStatus,
} from "@trigger.dev/core/v3";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { Waitpoint } from "@trigger.dev/database";
import { useCallback, useRef } from "react";
import { z } from "zod";
import { AnimatedHourglassIcon } from "~/assets/icons/AnimatedHourglassIcon";
import { JSONEditor } from "~/components/code/JSONEditor";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { LiveCountdown } from "~/components/runs/v3/LiveTimer";
import { $replica } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, ProjectParamSchema, v3RunsPath } from "~/utils/pathBuilder";
import { engine } from "~/v3/runEngine.server";
import { SpinnerWhite } from "~/components/primitives/Spinner";
import { useEnvironment } from "~/hooks/useEnvironment";

const CompleteWaitpointFormData = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("MANUAL"),
    payload: z.string().optional(),
    isTimeout: z.string().optional(),
    successRedirect: z.string(),
    failureRedirect: z.string(),
  }),
  z.object({
    type: z.literal("DATETIME"),
    successRedirect: z.string(),
    failureRedirect: z.string(),
  }),
]);

const Params = EnvironmentParamSchema.extend({
  waitpointFriendlyId: z.string(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, waitpointFriendlyId } = Params.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: CompleteWaitpointFormData });

  if (!submission.value) {
    return json(submission);
  }

  try {
    //first check that the user has access to the project
    const project = await $replica.project.findUnique({
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

    const waitpointId = WaitpointId.toId(waitpointFriendlyId);

    const waitpoint = await $replica.waitpoint.findFirst({
      select: {
        projectId: true,
      },
      where: {
        id: waitpointId,
      },
    });

    if (waitpoint?.projectId !== project.id) {
      return redirectWithErrorMessage(
        submission.value.failureRedirect,
        request,
        "No waitpoint found"
      );
    }

    switch (submission.value.type) {
      case "DATETIME": {
        const result = await engine.completeWaitpoint({
          id: waitpointId,
        });

        return redirectWithSuccessMessage(
          submission.value.successRedirect,
          request,
          "Waitpoint skipped"
        );
      }
      case "MANUAL": {
        if (submission.value.isTimeout) {
          try {
            const result = await engine.completeWaitpoint({
              id: waitpointId,
              output: {
                type: "application/json",
                value: JSON.stringify(timeoutError(new Date())),
                isError: true,
              },
            });

            return redirectWithSuccessMessage(
              submission.value.successRedirect,
              request,
              "Waitpoint timed out"
            );
          } catch (e) {
            return redirectWithErrorMessage(
              submission.value.failureRedirect,
              request,
              "Invalid payload, must be valid JSON"
            );
          }
        }

        try {
          if (
            submission.value.payload &&
            submission.value.payload.length > env.TASK_PAYLOAD_MAXIMUM_SIZE
          ) {
            return redirectWithErrorMessage(
              submission.value.failureRedirect,
              request,
              "Payload is too large"
            );
          }

          const data = submission.value.payload ? JSON.parse(submission.value.payload) : {};
          const stringifiedData = await stringifyIO(data);
          const finalData = await conditionallyExportPacket(
            stringifiedData,
            `${waitpointId}/waitpoint/token`
          );

          const result = await engine.completeWaitpoint({
            id: waitpointId,
            output: finalData.data
              ? { type: finalData.dataType, value: finalData.data, isError: false }
              : undefined,
          });

          return redirectWithSuccessMessage(
            submission.value.successRedirect,
            request,
            "Waitpoint completed"
          );
        } catch (e) {
          return redirectWithErrorMessage(
            submission.value.failureRedirect,
            request,
            "Invalid payload, must be valid JSON"
          );
        }
      }
    }
  } catch (error: any) {
    logger.error("Failed to complete waitpoint", error);

    const errorMessage = `Something went wrong. Please try again.`;
    return redirectWithErrorMessage(
      v3RunsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
      request,
      errorMessage
    );
  }
};

type FormWaitpoint = Pick<Waitpoint, "id" | "type" | "completedAfter"> & {
  status: WaitpointTokenStatus;
};

export function CompleteWaitpointForm({ waitpoint }: { waitpoint: FormWaitpoint }) {
  return (
    <div className="space-y-3">
      {waitpoint.type === "DATETIME" ? (
        waitpoint.completedAfter ? (
          <CompleteDateTimeWaitpointForm
            waitpoint={{
              friendlyId: waitpoint.id,
              completedAfter: waitpoint.completedAfter,
            }}
          />
        ) : (
          <>Waitpoint doesn't have a complete date</>
        )
      ) : (
        <CompleteManualWaitpointForm waitpoint={waitpoint} />
      )}
    </div>
  );
}

function CompleteDateTimeWaitpointForm({
  waitpoint,
}: {
  waitpoint: { friendlyId: string; completedAfter: Date };
}) {
  const location = useLocation();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const timeToComplete = waitpoint.completedAfter.getTime() - Date.now();
  if (timeToComplete < 0) {
    return (
      <div className="flex items-center justify-center">
        <Paragraph variant="small/bright">Waitpoint completed</Paragraph>
      </div>
    );
  }

  return (
    <Form
      action={`/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/waitpoints/${waitpoint.friendlyId}/complete`}
      method="post"
      className="grid h-full max-h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden border-t border-grid-bright"
    >
      <div className="mx-3 flex items-center">
        <Paragraph variant="small/bright">Manually skip this waitpoint</Paragraph>
      </div>
      <div className="border-t border-grid-dimmed">
        <input type="hidden" name="type" value={"DATETIME"} />
        <input
          type="hidden"
          name="successRedirect"
          value={`${location.pathname}${location.search}`}
        />
        <input
          type="hidden"
          name="failureRedirect"
          value={`${location.pathname}${location.search}`}
        />
        <div className="flex flex-wrap items-center justify-between gap-1 p-2 text-sm tabular-nums">
          <div className="flex items-center gap-1">
            <AnimatedHourglassIcon
              className="text-dimmed-dimmed size-4"
              delay={(waitpoint.completedAfter.getMilliseconds() - Date.now()) / 1000}
            />
            <span className="mt-0.5 ">
              <LiveCountdown endTime={waitpoint.completedAfter} />
            </span>
          </div>
          <DateTime date={waitpoint.completedAfter} />
        </div>
      </div>
      <div className="flex items-center justify-end border-t border-grid-dimmed bg-background-dimmed px-2">
        <Button
          variant="secondary/medium"
          type="submit"
          disabled={isLoading}
          LeadingIcon={isLoading ? SpinnerWhite : undefined}
        >
          {isLoading ? "Completing…" : "Skip waitpoint"}
        </Button>
      </div>
    </Form>
  );
}

function CompleteManualWaitpointForm({ waitpoint }: { waitpoint: { id: string } }) {
  const location = useLocation();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const currentJson = useRef<string>("{\n\n}");
  const formAction = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/waitpoints/${waitpoint.id}/complete`;

  const submitForm = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      const formData = new FormData(e.currentTarget);
      const data: Record<string, string> = {
        type: formData.get("type") as string,
        failureRedirect: formData.get("failureRedirect") as string,
        successRedirect: formData.get("successRedirect") as string,
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
    <>
      <Form
        action={formAction}
        method="post"
        onSubmit={(e) => submitForm(e)}
        className="grid h-full max-h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden border-t border-grid-bright"
      >
        <input type="hidden" name="type" value={"MANUAL"} />
        <input
          type="hidden"
          name="successRedirect"
          value={`${location.pathname}${location.search}`}
        />
        <input
          type="hidden"
          name="failureRedirect"
          value={`${location.pathname}${location.search}`}
        />
        <div className="mx-3 flex items-center gap-1">
          <Paragraph variant="small/bright">Manually complete this waitpoint</Paragraph>
          <InfoIconTooltip
            content={
              "This is will immediately complete this waitpoint with the payload you specify. This is useful during development for testing."
            }
            contentClassName="normal-case tracking-normal max-w-xs"
          />
        </div>
        <div className="overflow-y-auto bg-charcoal-900 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
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
        <div className="flex items-center justify-end gap-2 border-t border-grid-dimmed bg-background-dimmed px-2">
          <Button
            variant="secondary/medium"
            type="submit"
            disabled={isLoading}
            LeadingIcon={isLoading ? SpinnerWhite : undefined}
          >
            {isLoading ? "Completing…" : "Complete waitpoint"}
          </Button>
        </div>
      </Form>
    </>
  );
}

export function ForceTimeout({ waitpoint }: { waitpoint: { id: string } }) {
  const location = useLocation();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const formAction = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/waitpoints/${waitpoint.id}/complete`;

  return (
    <Form action={formAction} method="post">
      <input type="hidden" name="type" value={"MANUAL"} />
      <input type="hidden" name="isTimeout" value={"1"} />
      <input
        type="hidden"
        name="successRedirect"
        value={`${location.pathname}${location.search}`}
      />
      <input
        type="hidden"
        name="failureRedirect"
        value={`${location.pathname}${location.search}`}
      />
      <Button
        variant="tertiary/small"
        type="submit"
        disabled={isLoading}
        LeadingIcon={isLoading ? SpinnerWhite : undefined}
      >
        {isLoading ? "Forcing timeout…" : "Force timeout"}
      </Button>
    </Form>
  );
}
