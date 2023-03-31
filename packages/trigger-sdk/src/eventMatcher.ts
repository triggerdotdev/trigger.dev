import { ApiEventLog, EventFilter } from "@trigger.dev/internal";

export class EventMatcher {
  event: ApiEventLog;

  constructor(event: ApiEventLog) {
    this.event = event;
  }

  public matches(filter: EventFilter) {
    return patternMatches(this.event, filter);
  }
}

function patternMatches(payload: any, pattern: any): boolean {
  for (const [patternKey, patternValue] of Object.entries(pattern)) {
    const payloadValue = payload[patternKey];

    if (Array.isArray(patternValue)) {
      if (patternValue.length > 0 && !patternValue.includes(payloadValue)) {
        return false;
      }
    } else if (typeof patternValue === "object") {
      if (Array.isArray(payloadValue)) {
        if (!payloadValue.some((item) => patternMatches(item, patternValue))) {
          return false;
        }
      } else {
        if (!patternMatches(payloadValue, patternValue)) {
          return false;
        }
      }
    }
  }
  return true;
}
