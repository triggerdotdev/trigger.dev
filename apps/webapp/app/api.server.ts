import { type ApiEventLog } from "@trigger.dev/core/schemas";
import { type EventRecord } from "@trigger.dev/database";

export function eventRecordToApiJson(eventRecord: EventRecord): ApiEventLog {
  return {
    id: eventRecord.eventId,
    name: eventRecord.name,
    payload: eventRecord.payload as any,
    context: eventRecord.context as any,
    timestamp: eventRecord.timestamp,
    deliverAt: eventRecord.deliverAt,
    deliveredAt: eventRecord.deliveredAt,
    cancelledAt: eventRecord.cancelledAt,
  };
}
