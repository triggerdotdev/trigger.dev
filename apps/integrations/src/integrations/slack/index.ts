import { Service } from "core/service/types";
import { authentication } from "./authentication";
import * as actions from "./actions/actions";

export const slack: Service = {
  name: "Slack",
  service: "slack",
  version: "2.0.0",
  live: false,
  authentication,
  actions,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};
