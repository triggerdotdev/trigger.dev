import { Service } from "core/service/types";
import { authentication } from "./authentication";
import { webhooks } from "./webhooks/webhooks";

export const stripe: Service = {
  name: "Stripe",
  service: "stripe",
  version: "0.1.21",
  baseUrl: "https://api.stripe.com/v1",
  live: true,
  authentication,
  webhooks,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};
