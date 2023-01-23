export * from "./events";
export * from "./trigger";
export * from "./customEvents";
export * from "./fetch";

import { triggerRunLocalStorage } from "./localStorage";
import { SecureString } from "./types";

export function getTriggerRun() {
  return triggerRunLocalStorage.getStore();
}

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
