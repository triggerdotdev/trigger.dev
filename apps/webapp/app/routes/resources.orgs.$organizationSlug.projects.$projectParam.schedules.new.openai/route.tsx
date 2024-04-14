import { useFetcher, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { Label } from "~/components/primitives/Label";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema } from "~/utils/pathBuilder";
import OpenAI from "openai";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { FormError } from "~/components/primitives/FormError";
import { AISparkleIcon } from "~/assets/icons/AISparkleIcon";

const schema = z.object({
  message: z.string(),
});

const ResultSchema = z.object({
  isValid: z.boolean(),
  cron: z.string().optional(),
  error: z.string().optional(),
});

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  if (!env.OPENAI_API_KEY) {
    return json(
      {
        isValid: false as const,
        error: "OpenAI API key is not set",
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
      },
      { status: 400 }
    );
  }

  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You are a helpful assistant who will turn nautral language into a valid CRON expresion. 
          
          The version of CRON that we use is an extension of the minimal.

*    *    *    *    *
┬    ┬    ┬    ┬    ┬
│    │    │    │    |
│    │    │    │    └ day of week (0 - 7, 1L - 7L) (0 or 7 is Sun)
│    │    │    └───── month (1 - 12)
│    │    └────────── day of month (1 - 31, L)
│    └─────────────── hour (0 - 23)
└──────────────────── minute (0 - 59)

Supports mixed use of ranges and range increments (W character not supported currently). See tests for examples.

          Return JSON in one of these formats, putting in the correct data where you see <THE CRON EXPRESSION> and <ERROR MESSAGE DESCRIBING WHY IT'S NOT VALID>:
        1. If it's valid: { "isValid": true, "cron": "<THE CRON EXPRESSION>" }
        2. If it's not possible to make a valid CRON expression: { "isValid": false, "error": "<ERROR MESSAGE DESCRIBING WHY IT'S NOT VALID>"}`,
        },
        {
          role: "user",
          content: `What is a valid CRON expression for this: ${submission.data.message}`,
        },
      ],
      model: "gpt-3.5-turbo",
    });

    if (!completion.choices[0]?.message.content) {
      return json(
        {
          isValid: false as const,
          error: "No response from OpenAI",
        },
        { status: 500 }
      );
    }

    try {
      const jsonResponse = JSON.parse(completion.choices[0].message.content);
      const parsedResponse = ResultSchema.safeParse(jsonResponse);

      if (!parsedResponse.success) {
        return json(
          {
            isValid: false as const,
            error: "Invalid response from OpenAI",
          },
          { status: 400 }
        );
      }

      return json(parsedResponse.data);
    } catch (error: any) {
      return json(
        {
          isValid: false as const,
          error: "Invalid response from OpenAI, not JSON",
        },
        { status: 400 }
      );
    }
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
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

  const result = fetcher.data ? ResultSchema.safeParse(fetcher.data) : undefined;
  const resultData = result?.success === true ? result.data : undefined;

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
        action: `/resources/orgs/${organization.slug}/projects/${project.slug}/schedules/new/openai`,
        encType: "application/json",
      }
    );
  }, []);

  return (
    <div>
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
            onChange={(e) => setText(e.target.value)}
            rows={6}
            className="m-0 w-full border-0 bg-background-bright px-3 py-2 text-sm text-text-bright scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 file:border-0 file:bg-transparent file:text-base file:font-medium focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex justify-end gap-2 px-2 pb-2">
            <Button
              type="button"
              variant="tertiary/small"
              disabled={isLoading}
              LeadingIcon={isLoading ? "spinner" : AISparkleIcon}
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
