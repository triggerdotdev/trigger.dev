import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useLocation, useNavigation, useSubmit } from "@remix-run/react";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { useVirtualizer } from "@tanstack/react-virtual";
import { parseExpression } from "cron-parser";
import cronstrue from "cronstrue";
import { useCallback, useRef, useState } from "react";
import {
  environmentTextClassName,
  environmentTitle,
} from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
import { DateTime } from "~/components/primitives/DateTime";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { EditableScheduleElements } from "~/presenters/v3/EditSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, docsPath, v3SchedulesPath } from "~/utils/pathBuilder";
import { CronPattern, UpsertSchedule } from "~/v3/schedules";
import { UpsertTaskScheduleService } from "~/v3/services/upsertTaskSchedule.server";
import { AIGeneratedCronField } from "../resources.orgs.$organizationSlug.projects.$projectParam.schedules.new.natural-language";
import { TimezoneList } from "~/components/scheduled/timezones";
import { logger } from "~/services/logger.server";
import { Waitpoint } from "@trigger.dev/database";
import { z } from "zod";
import { JSONEditor } from "~/components/code/JSONEditor";

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
  const currentJson = useRef<string>("");
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
    <Form
      action={formAction}
      method="post"
      onSubmit={(e) => submitForm(e)}
      className="grid h-full max-h-full grid-rows-[2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright"
    >
      <div className="mx-3 flex items-center justify-between gap-2 border-b border-grid-dimmed">
        <Header2 className={cn("whitespace-nowrap")}>Complete waitpoint</Header2>
      </div>
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="p-3">
          <input type="hidden" name="type" value={waitpoint.type} />
          <Fieldset>
            <InputGroup>
              <Label>Payload</Label>
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
            </InputGroup>
          </Fieldset>
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-grid-dimmed px-2">
        <div className="flex items-center gap-4">
          <Button
            variant="primary/medium"
            type="submit"
            disabled={isLoading}
            shortcut={{ key: "enter", modifiers: ["mod"] }}
            LeadingIcon={isLoading ? "spinner" : undefined}
          >
            {isLoading ? "Completing…" : "Complete"}
          </Button>
        </div>
      </div>
    </Form>
  );
}
