import { JSONSchema } from "core/schemas/types";
import { TimeZoneRequest } from "./timezone";

export const DateRequest: JSONSchema = {
  type: "object",
  properties: {
    start: {
      type: "string",
    },
    end: {
      type: ["string", "null"],
    },
    time_zone: {
      anyOf: [
        TimeZoneRequest,
        {
          type: "null",
        },
      ],
    },
  },
  required: ["start"],
  additionalProperties: false,
};
