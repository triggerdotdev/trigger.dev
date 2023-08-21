import { ApiEventLog } from "@trigger.dev/core";
import { EventRecord } from "@trigger.dev/database";

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
