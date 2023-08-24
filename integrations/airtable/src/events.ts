import { EventSpecification } from "@trigger.dev/sdk";
import { WebhookPayload } from "./schemas";

type OnTableChanged = WebhookPayload;

export const onTableChanged: EventSpecification<OnTableChanged> = {
  name: "changed",
  title: "On Table Changed",
  source: "airtable.com",
  icon: "airtable",
  //todo properties with base and table (if there is one), maybe other specs too
  // properties: [
  //todo: add a payload example
  // examples: [
  //   {
  //     id: "recurring",
  //     name: "Recurring Price",
  //     icon: "airtable",
  //     payload: {
  //       id: "price_1NYV6vI0XSgju2urKsSmI53v",
  //       object: "price",
  //       active: true,
  //       billing_scheme: "per_unit",
  //       created: 1690467853,
  //       currency: "usd",
  //       custom_unit_amount: null,
  //       livemode: false,
  //       lookup_key: null,
  //       metadata: {},
  //       nickname: null,
  //       product: "prod_OLBTh0QPxDXkIU",
  //       recurring: {
  //         aggregate_usage: null,
  //         interval: "month",
  //         interval_count: 1,
  //         trial_period_days: null,
  //         usage_type: "licensed",
  //       },
  //       tax_behavior: "unspecified",
  //       tiers_mode: null,
  //       transform_quantity: null,
  //       type: "recurring",
  //       unit_amount: 1500,
  //       unit_amount_decimal: "1500",
  //     },
  //   },
  // ],
  parsePayload: (payload) => payload as OnTableChanged,
  runProperties: (payload) => [{ label: "Change source", text: payload.actionMetadata.source }],
};
