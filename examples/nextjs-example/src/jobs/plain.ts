import { client } from "@/trigger";
import {
  ComponentDividerSpacingSize,
  ComponentTextColor,
  ComponentTextSize,
  Plain,
} from "@trigger.dev/plain";
import { Job, eventTrigger } from "@trigger.dev/sdk";

export const plain = new Plain({
  id: "plain-1",
  apiKey: process.env.PLAIN_API_KEY!,
});

client.defineJob({
  id: "plain-playground",
  name: "Plain Playground",
  version: "0.1.1",
  integrations: {
    plain,
  },
  trigger: eventTrigger({
    name: "plain.playground",
  }),
  run: async (payload, io, ctx) => {
    const { customer } = await io.plain.upsertCustomer("upsert-customer", {
      identifier: {
        emailAddress: "eric@trigger.dev",
      },
      onCreate: {
        email: {
          email: "eric@trigger.dev",
          isVerified: true,
        },
        fullName: "Eric Allam",
        externalId: "123",
      },
      onUpdate: {
        fullName: {
          value: "Eric Allam",
        },
        externalId: {
          value: "123",
        },
      },
    });

    const foundCustomer = await io.plain.getCustomerById("get-customer", {
      customerId: customer.id,
    });

    const timelineEntry = await io.plain.upsertCustomTimelineEntry(
      "upsert-timeline-entry",
      {
        customerId: customer.id,
        title: "My timeline entry",
        components: [
          {
            componentText: {
              text: `This is a nice title`,
            },
          },
          {
            componentDivider: {
              dividerSpacingSize: ComponentDividerSpacingSize.M,
            },
          },
          {
            componentText: {
              textSize: ComponentTextSize.S,
              textColor: ComponentTextColor.Muted,
              text: "External id",
            },
          },
          {
            componentText: {
              text: foundCustomer?.externalId ?? "",
            },
          },
        ],
      }
    );
  },
});
