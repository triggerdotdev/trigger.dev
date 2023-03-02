import { makeWebhook } from "core/webhook";
import { authentication } from "../authentication";
import { formResponse } from "./specs";

const baseUrl = "https://api.typeform.com";

const webhook = makeWebhook(
  {
    baseUrl,
    spec: formResponse,
    authentication,
  },
  (result) => ({
    ...result,
    secret: "super-secret",
  })
);

export default {
  formResponse: webhook,
};
