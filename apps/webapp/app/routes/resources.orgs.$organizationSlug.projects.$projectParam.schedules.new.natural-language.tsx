import { useFetcher } from "@remix-run/react";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";
import { Button } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Label } from "~/components/primitives/Label";
import { Spinner } from "~/components/primitives/Spinner";
import { env } from "~/env.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { requireUserId } from "~/services/session.server";
import { humanToCron } from "~/v3/humanToCron.server";

const schema = z.object({
  message: z.string(),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);

  if (!env.OPENAI_API_KEY) {
    return json(
      {
        isValid: false as const,
        error: "OpenAI API key is not set",
        cron: undefined,
      },
      { status: 400 }
    );
  }

  const data = await request.json();
  const submission = schema.safeParse(data);

  if (!submission.success) {
    return json(
      {
        isValid: false as const,
        error: "Invalid input",
        cron: undefined,
      },
      { status: 400 }
    );
  }

  const result = await humanToCron(submission.data.message, userId);

  return json(result);
};

type AIGeneratedCronFieldProps = {
  onSuccess: (cron: string) => void;
};

export function AIGeneratedCronField({ onSuccess }: AIGeneratedCronFieldProps) {
  const fetcher = useFetcher<typeof action>();
  const [text, setText] = useState<string>("");
  const organization = useOrganization();
  const project = useProject();
  const isLoading = fetcher.state !== "idle";

  const resultData = fetcher.data;

  useEffect(() => {
    if (resultData?.cron !== undefined) {
      onSuccess(resultData.cron);
    }
  }, [resultData?.cron]);

  const submit = useCallback(async (value: string) => {
    fetcher.submit(
      { message: value },
      {
        method: "POST",
        action: `/resources/orgs/${organization.slug}/projects/${project.slug}/schedules/new/natural-language`,
        encType: "application/json",
      }
    );
  }, []);

  return (
    <div className="max-w-md">
      <Label>
        <AISparkleIcon className="inline-block h-4 w-4" /> Describe your schedule using natural
        language
      </Label>
      <div
        className="rounded-sm p-px"
        style={{ background: "linear-gradient(to bottom right, #E543FF, #286399)" }}
      >
        <div className="rounded-[calc(0.5rem-2px)] bg-background-bright">
          <textarea
            value={text}
            placeholder="e.g. the last Friday of the month at 6am"
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="m-0 min-h-10 w-full border-0 bg-background-bright px-3 py-2 text-sm text-text-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 file:border-0 file:bg-transparent file:text-base file:font-medium focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex justify-end gap-2 px-2 pb-2">
            <Button
              type="button"
              variant="tertiary/small"
              disabled={isLoading}
              LeadingIcon={isLoading ? Spinner : AISparkleIcon}
              onClick={() => submit(text)}
            >
              {isLoading ? "Generating" : "Generate"}
            </Button>
          </div>
        </div>
      </div>
      {resultData?.isValid === false ? (
        <FormError className="mt-2">{resultData.error}</FormError>
      ) : null}
    </div>
  );
}
