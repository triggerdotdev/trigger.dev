import { openai } from "@ai-sdk/openai";
import { BackgroundWorkerTask } from "@trigger.dev/database";
import { generateText, LanguageModelV1, Output } from "ai";
import { z } from "zod";
import { safeJsonParse } from "~/utils/json";

export type GenerateTextPayloadParams = {
  prompt?: string;
  backgroundTask: BackgroundWorkerTask;
};

export type GenerateTextPayloadResult =
  | {
      ok: true;
      payload: string;
    }
  | {
      ok: false;
      error: string;
    };

const GenerateTextPayloadResponseSchema = z.object({
  payload: z.string().describe("The payload to generate"),
});

export class AI {
  constructor(private readonly model: LanguageModelV1 = openai("gpt-4o-mini")) {}

  public get tasks() {
    return {
      generateTextPayload: async (
        params: GenerateTextPayloadParams
      ): Promise<GenerateTextPayloadResult> => {
        const result = await generateText({
          model: this.model,
          experimental_output: Output.object({ schema: GenerateTextPayloadResponseSchema }),
          maxSteps: 1,
          system: `
  You are an AI assistant that generates realistic example JSON payloads given JSON schemas, types, and a natural language description or prompt.
  
  IMPORTANT: The response must be a valid JSON object with exactly this structure:

  {
    "payload": "The stringified JSON payload to generate"
  }

  ## Task Details
  ID: ${params.backgroundTask.slug}
  File Path: ${params.backgroundTask.filePath}
  Description: ${params.backgroundTask.description ?? "No description provided"}

  ## JSON Schema

  ${
    params.backgroundTask.payloadSchema
      ? `${JSON.stringify(params.backgroundTask.payloadSchema, null, 2)}`
      : "There is no JSON schema provided. Please do your best given the natural language description or prompt."
  }
  `,
          prompt: params.prompt ?? "Generate a realistic example JSON payload",
          experimental_telemetry: {
            isEnabled: true,
            metadata: {
              backgroundTaskId: params.backgroundTask.id,
            },
          },
        });

        console.log("AI.tasks.generateTextPayload result", result);

        if (!result.experimental_output) {
          return {
            ok: false,
            error: "No output",
          };
        }

        if (typeof result.experimental_output.payload !== "string") {
          return {
            ok: false,
            error: "Payload is not a string",
          };
        }

        const parsedPayload = safeJsonParse(result.experimental_output.payload);

        if (!parsedPayload) {
          return {
            ok: false,
            error: "Payload is not a valid JSON object",
          };
        }

        return {
          ok: true,
          payload: JSON.stringify(parsedPayload, null, 2),
        };
      },
    };
  }
}
