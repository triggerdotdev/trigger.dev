import { Service } from "core/service/types";
import { authentication } from "./authentication";
import actions from "./actions/actions";

export const sendgrid: Service = {
  name: "SendGrid",
  service: "sendgrid",
  version: "0.1.21",
  baseUrl: "https://api.sendgrid.com",
  live: true,
  authentication,
  actions,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};
