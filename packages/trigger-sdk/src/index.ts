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

import { SecureString } from "./types";

export type { NormalizedRequest, EventFilter } from "@trigger.dev/internal";

/*
 * This function is used to create a secure string that can be used in the headers of a fetch request.
 * It is used to prevent the string from being logged in trigger.dev.
 * You can use it like this:
 *
 * await ctx.fetch("https://example.com", {
 *  headers: {
 *    Authorization: secureString`Bearer ${ACCESS_TOKEN}`,
 *  },
 * })
 */
export function secureString(
  strings: TemplateStringsArray,
  ...interpolations: string[]
): SecureString {
  return {
    __secureString: true,
    strings: strings.raw as string[],
    interpolations,
  };
}
