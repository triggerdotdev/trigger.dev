import { batch, logger, schemaTask, wait } from "@trigger.dev/sdk/v3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CSVRowPayload, RowEnrichmentResult } from "./schemas";
import { python } from "@trigger.dev/python";

export const d3Demo = schemaTask({
  id: "d3-demo",
  description: "D3 Demo - Enriches a CSV dataset using Trigger.dev and the python OpenAI Agent SDK",
  schema: z.object({
    url: z.string().url().describe("The URL of the CSV dataset to enrich"),
  }),
  run: async ({ url }) => {
    const response = await fetch(url);
    const csv = await response.text();

    const header = csv.split("\n")[0];
    const rows = csv.split("\n").slice(1);

    // Each payload has a header, url, and a single row
    const payloads = rows.map((row) => ({
      header,
      url,
      row,
    }));

    const chunkedPayloads = [];

    for (let i = 0; i < payloads.length; i += 500) {
      chunkedPayloads.push(payloads.slice(i, i + 500));
    }

    // Process each chunk
    for (const chunk of chunkedPayloads) {
      const results = await batch.triggerAndWait<typeof handleCSVRow>(
        chunk.map((payload) => ({
          id: "handle-csv-row",
          payload,
          options: {
            idempotencyKey: createIdempotencyKey(payload),
          },
        }))
      );

      for (const result of results.runs) {
        if (result.ok) {
          // Pretty print the result of the enrichment
          logger.log(`Enriched row ${result.output.row}`, result.output);
        } else {
          logger.error(`Error enriching row: ${result.error}`);
        }
      }
    }
  },
});

const ROW_AGENT_RUNNER_COUNT = 10;

export const handleCSVRow = schemaTask({
  id: "handle-csv-row",
  description: "Handles a single row of a CSV dataset",
  schema: CSVRowPayload,
  run: async ({ header, row, url }) => {
    // Batch trigger the rowAgentCoordinator to try 10 different enrichments on the same row
    const results = await batch.triggerAndWait<typeof rowAgentCoordinator>(
      Array.from({ length: ROW_AGENT_RUNNER_COUNT }, () => ({
        id: "row-agent-coordinator" as const,
        payload: { row: { header, row, url } },
      }))
    );

    const outputs = results.runs.filter((result) => result.ok).map((result) => result.output);

    const enrichment = await enrichmentResultsEvaluator
      .triggerAndWait({
        results: outputs,
      })
      .unwrap();

    return {
      enrichment,
      header,
      row,
      url,
    };
  },
});

export const rowAgentCoordinator = schemaTask({
  id: "row-agent-coordinator",
  description: "Coordinators the row agent",
  schema: z.object({
    row: CSVRowPayload,
  }),
  run: async ({ row }) => {
    const waitToken = await wait.createToken({
      timeout: "2m",
    });

    const jsonSchema = zodToJsonSchema(RowEnrichmentResult);

    await rowAgentRunner.trigger({
      row,
      waitToken,
      jsonSchema,
    });

    const result = await wait.forToken<RowEnrichmentResult>(waitToken.id);

    if (!result.ok) {
      throw result.error;
    }

    return result.output;
  },
});

export const rowAgentRunner = schemaTask({
  id: "row-agent-runner",
  description: "Runs the row agent",
  schema: z.object({
    row: CSVRowPayload,
    waitToken: z.object({
      id: z
        .string()
        .describe(
          "The wait token that the OpenAI Agent SDK will use to signal back to the coordinator"
        ),
      publicAccessToken: z
        .string()
        .describe(
          "The public access token that the OpenAI Agent SDK will use to signal back to the coordinator"
        ),
    }),
    jsonSchema: z.any().describe("The JSON schema of the result"),
    disableWaitTokenCompletion: z
      .boolean()
      .default(false)
      .describe("Whether to disable wait token completion"),
  }),
  run: async ({ row, waitToken, jsonSchema, disableWaitTokenCompletion }) => {
    const inputData = JSON.stringify({
      row,
      waitToken,
      jsonSchema,
      disableWaitTokenCompletion,
    });

    logger.info("process.env", {
      env: process.env,
    });

    const result = await python.runScript("./src/trigger/python/agent.py", [inputData]);

    logger.debug("row-agent-runner", {
      result,
    });

    return {} as unknown as RowEnrichmentResult;
  },
  catchError: async ({ error }) => {
    logger.error("row-agent-runner", {
      error,
    });
  },
});

export const enrichmentResultsEvaluator = schemaTask({
  id: "enrichment-results-evaluator",
  description: "Evaluates the enrichment results",
  schema: z.object({
    results: z.array(RowEnrichmentResult),
  }),
  run: async ({ results }) => {
    // Combine the results into a single object (this is a placeholder for a more complex evaluation)
    const combinedResult = results.reduce(
      (acc, result) => ({
        ...acc,
        ...result,
      }),
      {} as RowEnrichmentResult
    );

    return combinedResult;
  },
});

// Create a hash of the payload using Node.js crypto
// Ideally, you'd do a stable serialization of the payload before hashing, to ensure the same payload always results in the same hash
function createIdempotencyKey(payload: CSVRowPayload): string {
  const content = `${payload.header}\n${payload.row}`;

  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}
