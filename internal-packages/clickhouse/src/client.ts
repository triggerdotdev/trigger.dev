import { createClient as createClickhouseClient } from "@clickhouse/client";

export function createClient(url: string) {
  const client = createClickhouseClient({
    url,
  });

  return client;
}
