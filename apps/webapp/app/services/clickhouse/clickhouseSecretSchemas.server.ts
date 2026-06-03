import { z } from "zod";

export const ClickhouseConnectionSchema = z.object({
  url: z.string().url(),
});

export type ClickhouseConnection = z.infer<typeof ClickhouseConnectionSchema>;

export function getClickhouseSecretKey(orgId: string, clientType: string): string {
  return `org:${orgId}:clickhouse:${clientType}`;
}
