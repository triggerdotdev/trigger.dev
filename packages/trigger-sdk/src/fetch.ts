import { triggerRunLocalStorage } from "./localStorage";
import { z } from "zod";
import { FetchOptions, FetchResponse } from "./types";

export function fetch<TBodySchema extends z.ZodTypeAny = z.ZodTypeAny>(
  key: string,
  url: string | URL,
  options: FetchOptions<TBodySchema>
): Promise<FetchResponse<TBodySchema>> {
  const triggerRun = triggerRunLocalStorage.getStore();

  if (!triggerRun) {
    throw new Error("Cannot call fetch outside of a trigger run");
  }

  return triggerRun.fetch(key, url, options);
}
