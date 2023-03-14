import { Service } from "core/service/types";
import { authentication } from "./authentication";
import { spec } from "./schemas/spec";
import { webhooks } from "./webhooks/webhooks";

export const typeform: Service = {
  name: "Typeform",
  service: "typeform",
  version: "0.1.21",
  baseUrl: "https://api.typeform.com",
  live: true,
  authentication,
  webhooks,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
  schema: spec,
};
