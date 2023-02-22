import { Service } from "core/service/types";
import { authentication } from "./authentication";
import * as actions from "./actions/actions";

export const slackv2: Service = {
  name: "Slack",
  service: "slackv2",
  version: "2.0.0",
  baseUrl: "https://slack.com/api",
  live: false,
  authentication,
  actions,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};
