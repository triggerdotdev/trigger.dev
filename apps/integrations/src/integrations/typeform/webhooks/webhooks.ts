import { makeWebhook } from "core/webhook";
import { authentication } from "../authentication";
import { formResponse } from "./specs";

const baseUrl = "https://api.typeform.com";

const webhook = makeWebhook({
  baseUrl,
  spec: formResponse,
  authentication,
});

export default {
  formResponse: webhook,
};
