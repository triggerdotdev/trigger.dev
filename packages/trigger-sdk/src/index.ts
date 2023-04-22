export * from "./triggers";
export * from "./job";
export * from "./customEvents";
export * from "./triggerClient";
export * from "./connections";
export * from "./externalSource";

import { webcrypto } from "node:crypto";
import { triggerRunLocalStorage } from "./localStorage";
import { SecureString } from "./types";

export function getTriggerRun() {
  return triggerRunLocalStorage.getStore();
}

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

export async function getCrypto(): Promise<webcrypto.Crypto> {
  if (typeof globalThis.crypto !== "undefined") {
    // Browser or environments with native WebCrypto support
    // @ts-ignore
    return globalThis.crypto;
  } else if (typeof require !== "undefined") {
    const { webcrypto } = await import("node:crypto");

    return webcrypto;
  } else {
    throw new Error("No crypto implementation available");
  }
}
