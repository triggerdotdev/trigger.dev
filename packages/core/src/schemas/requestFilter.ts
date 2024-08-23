import { z } from "zod";
import { EventFilterSchema, stringPatternMatchers } from "./eventFilter.js";
import { Prettify } from "../types.js";

const StringMatchSchema = z.union([
  /** Match against a string */
  z.array(z.string()),
  z.array(z.union(stringPatternMatchers)),
]);

export type StringMatch = z.infer<typeof StringMatchSchema>;

export const HTTPMethodUnionSchema = z.union([
  z.literal("GET"),
  z.literal("POST"),
  z.literal("PUT"),
  z.literal("PATCH"),
  z.literal("DELETE"),
  z.literal("HEAD"),
  z.literal("OPTIONS"),
]);

export type HttpMethod = z.infer<typeof HTTPMethodUnionSchema>;

/** Only Requests that match this filter will cause the `handler` function to run.
 * For example, you can use this to only respond to `GET` Requests. */
export const RequestFilterSchema = z.object({
  /** An array of HTTP methods to match.
   * For example, `["GET", "POST"]` will match both `GET` and `POST` Requests. */
  method: z.array(HTTPMethodUnionSchema).optional(),
  /** An object of header key/values to match. 
   * This uses the [EventFilter matching syntax](https://trigger.dev/docs/documentation/guides/event-filter).

    @example
  ```ts
  filter: {
    header: {
      "content-type": ["application/json"],
    },
  },
  ``` */
  headers: z.record(StringMatchSchema).optional(),
  /** An object of query parameters to match. 
   * This uses the [EventFilter matching syntax](https://trigger.dev/docs/documentation/guides/event-filter).

  @example
  ```ts
  filter: {
    query: {
      "hub.mode": [{ $startsWith: "sub" }],
    },
  },
  ``` */
  query: z.record(StringMatchSchema).optional(),
  /** An object of key/values to match.
   * This uses the [EventFilter matching syntax](https://trigger.dev/docs/documentation/guides/event-filter).
   */
  body: EventFilterSchema.optional(),
});

export type RequestFilter = z.infer<typeof RequestFilterSchema>;

/** Only Requests that match this filter will cause the `handler` function to run.
 * For example, you can use this to only respond to `GET` Requests. */
export const ResponseFilterSchema = RequestFilterSchema.omit({ method: true, query: true }).extend({
  status: z.array(z.number()).optional(),
});

export type ResponseFilter = Prettify<z.infer<typeof ResponseFilterSchema>>;
