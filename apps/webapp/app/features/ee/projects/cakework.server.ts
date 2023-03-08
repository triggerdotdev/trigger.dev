import type { CakeworkApi } from "@cakework/client/dist";
import {
  CakeworkApiClient,
  CakeworkApiEnvironment,
} from "@cakework/client/dist";
import { env } from "~/env.server";

export const cakework = new CakeworkApiClient({
  environment: CakeworkApiEnvironment.Production,
  xApiKey: env.CAKEWORK_API_KEY,
});

export type GetLogsOptions = {
  query?: string;
  batch?: number;
  pagination?: string;
  from?: string | Date;
  to?: string | Date;
};

export type GetLogsResponse = CakeworkApi.VmLogs & {
  pagination?: string;
  from?: string;
  to?: string;
};

export type LogLine = {
  timestamp: number;
  level: string;
  message: string;
};

// Doing this using fetch because the cakework SDK doesn't support the options for this endpoint yet
export async function getBuildLogs(
  id: string,
  options: GetLogsOptions = {}
): Promise<GetLogsResponse> {
  return await getLogs(id, "image/build", options);
}

// Doing this using built in node.js http client library because the cakework SDK doesn't support the options for this endpoint yet
export async function getVmLogs(
  id: string,
  options: GetLogsOptions = {}
): Promise<GetLogsResponse> {
  return await getLogs(id, "vm", options);
}

async function getLogs(
  id: string,
  type: "vm" | "image/build",
  options: GetLogsOptions = {}
): Promise<GetLogsResponse> {
  const url = new URL(`https://api.cakework.com/v1/${type}/${id}/logs`);

  if (options.query) {
    url.searchParams.set("query", options.query);
  }

  if (options.pagination) {
    url.searchParams.set("pagination", options.pagination);
  }

  if (options.from) {
    url.searchParams.set(
      "from",
      typeof options.from === "string"
        ? options.from
        : options.from.toISOString()
    );
  }

  if (options.to) {
    url.searchParams.set(
      "to",
      typeof options.to === "string" ? options.to : options.to.toISOString()
    );
  }

  if (options.batch) {
    url.searchParams.set("batch", options.batch.toString());
  }

  console.log(`GET ${url.toString()}`);

  const response = await fetch(url.toString(), {
    headers: {
      "X-Api-Key": env.CAKEWORK_API_KEY,
      Accept: "application/json",
    },
  });

  console.log(
    `GET ${url.toString()}: ${response.status} ${response.statusText}`
  );

  if (!response.ok) {
    return { lines: [] };
  }

  return await response.json();
}
