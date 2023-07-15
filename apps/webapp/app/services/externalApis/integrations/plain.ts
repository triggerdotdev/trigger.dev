import type { Integration } from "../types";

export const plain: Integration = {
  identifier: "plain",
  name: "Plain",
  packageName: "@trigger.dev/plain@latest",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Plain } from "@trigger.dev/plain";

export const plain = new Plain({
  id: "__SLUG__",
  apiKey: process.env.PLAIN_API_KEY!,
});
`,
          },
          {
            title: "Using the client",
            code: `
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
        emailAddress: "rick.astley@gmail.com",
      },
      onCreate: {
        email: {
          email: "rick.astley@gmail.com",
          isVerified: true,
        },
        fullName: "Rick Astley",
        externalId: "u_123",
      },
      onUpdate: {
        fullName: {
          value: "Rick Astley",
        },
        externalId: {
          value: "u_123",
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
              text: \`This is a nice title\`,
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
            `,
            highlight: [[12, 68]],
          },
        ],
      },
    },
  },
};
