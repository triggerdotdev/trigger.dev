import { SendEventOptions } from "@trigger.dev/core";

export function calculateDeliverAt(options?: SendEventOptions) {
  // If deliverAt is a string and a valid date, convert it to a Date object
  if (options?.deliverAt) {
    return options?.deliverAt;
  }

  // deliverAfter is the number of seconds to wait before delivering the event
  if (options?.deliverAfter) {
    return new Date(Date.now() + options.deliverAfter * 1000);
  }

  return undefined;
}
