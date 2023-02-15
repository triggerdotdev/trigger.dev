import { Service } from "core/service/types";
import { authentication } from "./authentication";
import * as actions from "./actions/actions";

export const airtable: Service = {
  name: "Airtable",
  service: "airtable",
  version: "2.0.0",
  live: true,
  authentication,
  actions,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};
