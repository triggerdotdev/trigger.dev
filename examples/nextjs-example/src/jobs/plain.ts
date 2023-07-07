import { client } from "@/trigger";
import { Plain } from "@trigger.dev/plain";
import { Job, eventTrigger } from "@trigger.dev/sdk";

export const plain = new Plain({
  id: "plain-1",
  apiKey: process.env.PLAIN_API_KEY!,
});

new Job(client, {
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
  },
});
