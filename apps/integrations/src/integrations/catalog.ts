import { Catalog } from "core/catalog";
import { slackv2 } from "./slack";
import { airtable } from "./airtable";

export const catalog: Catalog = {
  services: {
    slackv2,
    airtable,
  },
};
