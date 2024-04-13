import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useFetcher, useLocation, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { parseExpression } from "cron-parser";
import cronstrue from "cronstrue";
import { useCallback, useState } from "react";
import { z } from "zod";
import {
  environmentTextClassName,
  environmentTitle,
} from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { DateTime } from "~/components/primitives/DateTime";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { useLocales } from "~/components/primitives/LocaleProvider";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TextArea } from "~/components/primitives/TextArea";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { EditableScheduleElements } from "~/presenters/v3/EditSchedulePresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, docsPath, v3SchedulesPath } from "~/utils/pathBuilder";
import { UpsertTaskScheduleService } from "~/v3/services/createTaskSchedule";

const schema = z.object({
  message: z.string(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const data = await request.json();
  const submission = schema.safeParse(data);

  if (!submission.success) {
    return json(
      {
        isValid: false as const,
        error: "Invalid input",
      },
      { status: 400 }
    );
  }

  try {
    return json({
      isValid: true as const,
      cron: "* 1 * * *",
    });

    throw new Error("Not implemented");
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

const ResultSchema = z.discriminatedUnion("isValid", [
  z.object({
    isValid: z.literal(true),
    cron: z.string(),
  }),
  z.object({
    isValid: z.literal(false),
    error: z.string(),
  }),
]);

type Result = z.infer<typeof ResultSchema>;

type AIGeneratedCronFieldProps = {};

export function AIGeneratedCronField({}: AIGeneratedCronFieldProps) {
  const fetcher = useFetcher<typeof action>();
  const [text, setText] = useState<string>("");
  const navigation = useNavigation();
  const organization = useOrganization();
  const project = useProject();
  const isLoading = navigation.state !== "idle";

  const result = fetcher.data ? ResultSchema.safeParse(fetcher.data) : undefined;
  if (result?.success) {
    console.log(result.data);
  }

  const submit = useCallback(async (value: string) => {
    fetcher.submit(
      { message: value },
      {
        method: "POST",
        action: `/resources/orgs/${organization.slug}/projects/${project.slug}/schedules/new/openai`,
        encType: "application/json",
      }
    );
  }, []);

  return (
    <div>
      <Label>Describe your schedule using natural language</Label>
      <div
        className="rounded-sm p-px"
        style={{ background: "linear-gradient(to bottom right, #E543FF, #286399)" }}
      >
        <div className="rounded-[calc(0.5rem-2px)] bg-background-bright">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            className="m-0 w-full border-0 bg-background-bright px-3 py-2 text-sm text-text-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 file:border-0 file:bg-transparent file:text-base file:font-medium focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex justify-end gap-2 px-2 pb-2">
            <Button
              type="button"
              variant="tertiary/small"
              disabled={isLoading}
              LeadingIcon={isLoading ? "spinner" : undefined}
              onClick={() => submit(text)}
            >
              {isLoading ? "Generating" : "Generate"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
