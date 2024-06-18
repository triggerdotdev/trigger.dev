import { randomUUID } from "node:crypto";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

export type UsageEvent = {
  source: string;
  subject: string;
  type: string;
  id?: string;
  time?: Date;
  data?: Record<string, unknown>;
};

export async function reportUsageEvent(event: UsageEvent) {
  if (!env.USAGE_OPEN_METER_BASE_URL || !env.USAGE_OPEN_METER_API_KEY) {
    return;
  }

  const body = {
    specversion: "1.0",
    id: event.id ?? randomUUID(),
    source: event.source,
    type: event.type,
    time: (event.time ?? new Date()).toISOString(),
    subject: event.subject,
    datacontenttype: "application/json",
    data: event.data,
  };

  const url = `${env.USAGE_OPEN_METER_BASE_URL}/api/v1/events`;

  logger.debug("Reporting usage event to OpenMeter", { url, body });

  const response = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/cloudevents+json",
      Authorization: `Bearer ${env.USAGE_OPEN_METER_API_KEY}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    logger.error(`Failed to report usage event: ${response.status} ${response.statusText}`);
  }
}
