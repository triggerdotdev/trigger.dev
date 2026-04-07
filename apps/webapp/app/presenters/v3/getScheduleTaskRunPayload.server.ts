import { ScheduledTaskPayload, parsePacket } from "@trigger.dev/core/v3";

export async function getScheduleTaskRunPayload(payload: string, payloadType: string) {
  let packet: unknown;

  try {
    packet = await parsePacket({ data: payload, dataType: payloadType });
  } catch {
    packet = undefined;
  }

  if (packet && typeof packet === "object" && !Array.isArray(packet)) {
    const maybeTimezone = (packet as { timezone?: unknown }).timezone;

    if (typeof maybeTimezone !== "string" || maybeTimezone.length === 0) {
      (packet as { timezone: string }).timezone = "UTC";
    }
  }

  return ScheduledTaskPayload.safeParse(packet);
}

