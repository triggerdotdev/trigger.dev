import { Catalog } from "core/catalog";
import { airtable } from "./airtable";
import { notion } from "./notion";
import { sendgrid } from "./sendgrid";
import { typeform } from "./typeform";

export const catalog: Catalog = {
  services: {
    airtable,
    notion,
    sendgrid,
    typeform,
  },
};
