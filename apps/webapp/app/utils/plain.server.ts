import { PlainClient, uiComponent } from "@team-plain/typescript-sdk";
import { env } from "~/env.server";

type Input = {
  userId: string;
  email: string;
  name: string;
  title: string;
  components: ReturnType<typeof uiComponent.text>[];
};

export async function sendToPlain({ userId, email, name, title, components }: Input) {
  if (!env.PLAIN_API_KEY) {
    return;
  }

  const client = new PlainClient({
    apiKey: env.PLAIN_API_KEY,
  });

  const upsertCustomerRes = await client.upsertCustomer({
    identifier: {
      emailAddress: email,
    },
    onCreate: {
      externalId: userId,
      fullName: name,
      email: {
        email: email,
        isVerified: true,
      },
    },
    onUpdate: {
      externalId: { value: userId },
      fullName: { value: name },
      email: {
        email: email,
        isVerified: true,
      },
    },
  });

  if (upsertCustomerRes.error) {
    console.error("Failed to upsert customer in Plain", upsertCustomerRes.error);
    return;
  }

  const createThreadRes = await client.createThread({
    customerIdentifier: {
      customerId: upsertCustomerRes.data.customer.id,
    },
    title: title,
    components: components,
  });

  if (createThreadRes.error) {
    console.error("Failed to create thread in Plain", createThreadRes.error);
  }
}
