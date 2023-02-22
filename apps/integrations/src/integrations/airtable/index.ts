import { Service } from "core/service/types";
import { authentication } from "./authentication";
import actions from "./actions/actions";

export const airtable: Service = {
  name: "Airtable",
  service: "airtable",
  version: "0.1.21",
  baseUrl: "https://api.airtable.com/v0",
  live: true,
  authentication,
  actions,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};
