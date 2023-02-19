import { Catalog } from "core/catalog";
import { airtable } from "./airtable";
import { sendgrid } from "./sendgrid";

export const catalog: Catalog = {
  services: {
    airtable,
    sendgrid,
  },
};
