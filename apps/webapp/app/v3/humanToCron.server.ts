import OpenAI from "openai";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { safeJsonParse } from "~/utils/json";

export const HumanToCronResult = z.object({
  isValid: z.boolean(),
  cron: z.string().optional(),
  error: z.string().optional(),
});

export type HumanToCronResult = z.infer<typeof HumanToCronResult>;

export const humanToCronSupported = typeof env.OPENAI_API_KEY === "string";

export async function humanToCron(message: string, userId: string): Promise<HumanToCronResult> {
  if (!humanToCronSupported) {
    return {
      isValid: false,
      error: "OpenAI API key is not set",
    };
  }

  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    user: userId,
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

Supports mixed use of ranges and range increments (W character not supported currently).

Special characters you must use instead of saying something is not possible:
- "L" in day of week means the last occurrence of that weekday in the month: 5L is the last Friday.
- "L" in day of month means the last day of the month.
- "#" in day of week means the nth occurrence of that weekday in the month: 2#2 is the second Tuesday.

Examples:
- "every weekday at 9am" -> 0 9 * * 1-5
- "the last Friday of the month at 6am" -> 0 6 * * 5L
- "the last Monday of every month at 9am" -> 0 9 * * 1L
- "the last day of the month at midnight" -> 0 0 L * *
- "the second Tuesday of every month at 3pm" -> 0 15 * * 2#2
- "every 15 minutes" -> */15 * * * *

          Return JSON in one of these formats, putting in the correct data where you see <THE CRON EXPRESSION> and <ERROR MESSAGE DESCRIBING WHY IT'S NOT VALID>:
        1. If it's valid: { "isValid": true, "cron": "<THE CRON EXPRESSION>" }
        2. If it's not possible to make a valid CRON expression: { "isValid": false, "error": "<ERROR MESSAGE DESCRIBING WHY IT'S NOT VALID>"}`,
      },
      {
        role: "user",
        content: `What is a valid CRON expression for this: ${message}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  if (!completion.choices[0]?.message.content) {
    return {
      isValid: false,
      error: "No response from OpenAI",
    };
  }

  logger.debug("OpenAI response", {
    completion,
  });

  const jsonResponse = safeJsonParse(completion.choices[0].message.content);

  if (!jsonResponse) {
    return {
      isValid: false,
      error: "Invalid response from OpenAI",
    };
  }

  const parsedResponse = HumanToCronResult.safeParse(jsonResponse);

  if (!parsedResponse.success) {
    return {
      isValid: false,
      error: `Invalid response from OpenAI: ${parsedResponse.error.message}`,
    };
  }

  return parsedResponse.data;
}
