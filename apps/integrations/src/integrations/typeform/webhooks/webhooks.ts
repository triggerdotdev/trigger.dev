import { makeWebhook } from "core/webhook";
import { authentication } from "../authentication";
import { formResponse } from "./specs";

const baseUrl = "https://api.typeform.com";

const webhook = makeWebhook({
  data: {
    baseUrl,
    spec: formResponse,
    authentication,
  },
  events: [],
  postSubscribe: (result) => ({
    ...result,
    secret: "super-secret",
  }),
});

export default {
  formResponse: webhook,
};
