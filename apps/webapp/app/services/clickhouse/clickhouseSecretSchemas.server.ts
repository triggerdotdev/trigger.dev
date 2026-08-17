import { z } from "zod";

export const ClickhouseConnectionSchema = z.object({
  url: z.string().url(),
});

type ClickhouseConnection = z.infer<typeof ClickhouseConnectionSchema>;

function getClickhouseSecretKey(orgId: string, clientType: string): string {
  return `org:${orgId}:clickhouse:${clientType}`;
}
