export * from "./job.js";
export * from "./triggerClient.js";
export * from "./integrations.js";
export * from "./triggers/eventTrigger.js";
export * from "./triggers/externalSource.js";
export * from "./triggers/dynamic.js";
export * from "./triggers/scheduled.js";
export * from "./triggers/notifications.js";
export * from "./triggers/invokeTrigger.js";
export * from "./triggers/webhook.js";
export * from "./io.js";
export * from "./types.js";
export * from "./utils.js";
export * from "./security.js";

import { ServerTask } from "@trigger.dev/core";
import { RedactString } from "./types.js";
export { isTriggerError } from "./errors.js";
export { retry } from "./retry.js";

export type { NormalizedRequest, EventFilter } from "@trigger.dev/core";

export type Task = ServerTask;

import { ApiEventLog } from "@trigger.dev/core";
export type SentEvent = ApiEventLog;

/*
 * This function is used to create a redacted string that can be used in the headers of a fetch request.
 * It is used to prevent the string from being logged in trigger.dev.
 * You can use it like this:
 *
 * await io.backgroundFetch<SomeResponseType>("https://example.com", {
 *  headers: {
 *    Authorization: redactString`Bearer ${ACCESS_TOKEN}`,
 *  },
 * })
 */
export function redactString(
  strings: TemplateStringsArray,
  ...interpolations: string[]
): RedactString {
  return {
    __redactedString: true,
    strings: strings.raw as string[],
    interpolations,
  };
}
