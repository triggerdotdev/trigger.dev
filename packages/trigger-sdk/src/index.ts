export * from "./job";
export * from "./triggerClient";
export * from "./integrations";
export * from "./triggers/eventTrigger";
export * from "./triggers/externalSource";
export * from "./triggers/dynamic";
export * from "./triggers/scheduled";
export * from "./triggers/notifications";
export * from "./io";
export * from "./types";

import { ServerTask } from "@trigger.dev/core";
import { RedactString } from "./types";
export { isTriggerError } from "./errors";

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
