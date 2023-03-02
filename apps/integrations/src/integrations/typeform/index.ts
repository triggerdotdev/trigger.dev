import { Service } from "core/service/types";
import { authentication } from "./authentication";

export const typeform: Service = {
  name: "Typeform",
  service: "typeform",
  version: "0.1.21",
  baseUrl: "https://api.typeform.com",
  live: true,
  authentication,
  actions: {},
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};
