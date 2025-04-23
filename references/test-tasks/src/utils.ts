import { runs } from "@trigger.dev/sdk/v3";
import { z } from "zod";

export type RunStatus = Awaited<ReturnType<typeof runs.retrieve>>["status"];

export async function waitForRunStatus(
  id: string,
  statuses: RunStatus[],
  timeoutInSeconds?: number,
  pollIntervalMs = 1_000
) {
  const run = await runs.retrieve(id);

  if (statuses.includes(run.status)) {
    return run;
  }

  const start = Date.now();

  while (Date.now() - start < (timeoutInSeconds ?? 300) * 1_000) {
    const run = await runs.retrieve(id);

    if (statuses.includes(run.status)) {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Run did not reach status ${statuses.join(" or ")} within ${timeoutInSeconds ?? 300} seconds`
  );
}

export async function updateEnvironmentConcurrencyLimit(
  environmentId: string,
  concurrencyLimit: number
) {
  if (!process.env.TRIGGER_API_URL) {
    throw new Error("TRIGGER_API_URL is not set");
  }

  if (!process.env.TRIGGER_ACCESS_TOKEN) {
    throw new Error("TRIGGER_ACCESS_TOKEN is not set");
  }

  // We need to make a request to baseURL + `/admin/api/v1/environments/${environmentId}` with a POST request
  // The body needs to be a JSON object with the key `envMaximumConcurrencyLimit` and the value `concurrencyLimit`, and the key `orgMaximumConcurrencyLimit` with the value `concurrencyLimit`
  // we also need a Authorization header that has the personal access token from process.env.TRIGGER_ACCESS_TOKEN

  const response = await fetch(
    `${process.env.TRIGGER_API_URL}/admin/api/v1/environments/${environmentId}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TRIGGER_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        envMaximumConcurrencyLimit: concurrencyLimit,
        orgMaximumConcurrencyLimit: concurrencyLimit,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to update environment concurrency limit: ${response.statusText}`);
  }

  return response.json();
}

const EnvironmentStatsResponseBody = z.object({
  id: z.string(),
  concurrencyLimit: z.number(),
  currentConcurrency: z.number(),
  queueConcurrency: z.number().optional(),
  queueCurrentConcurrency: z.number().optional(),
});

export type EnvironmentStatsResponseBody = z.infer<typeof EnvironmentStatsResponseBody>;

export async function getEnvironmentStats(
  environmentId: string,
  queue?: string
): Promise<EnvironmentStatsResponseBody> {
  const url = new URL(`${process.env.TRIGGER_API_URL}/admin/api/v1/environments/${environmentId}`);

  if (queue) {
    url.searchParams.set("queue", queue);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${process.env.TRIGGER_ACCESS_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch environment stats: ${response.statusText}`);
  }

  const responseBody = await response.json();

  return EnvironmentStatsResponseBody.parse(responseBody);
}
