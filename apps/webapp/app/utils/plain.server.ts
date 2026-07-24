import { PlainClient } from "@team-plain/graphql";
import type { uiComponent } from "@team-plain/ui-components";
import { env } from "~/env.server";

type Input = {
  userId: string;
  email: string;
  name: string;
  title: string;
  components: ReturnType<typeof uiComponent.text>[];
  labelTypeIds?: string[];
};

export async function sendToPlain({ userId, email, name, title, components, labelTypeIds }: Input) {
  if (!env.PLAIN_API_KEY) {
    return;
  }

  const client = new PlainClient({
    apiKey: env.PLAIN_API_KEY,
  });

  // Best-effort support side-effect: the new client throws on failure, so we swallow and log
  // rather than break the user action that triggered it.
  try {
    const upsertCustomerRes = await client.mutation.upsertCustomer({
      input: {
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
      },
    });

    const customerId = upsertCustomerRes.customer?.id;
    if (!customerId) {
      console.error("Failed to upsert customer in Plain", upsertCustomerRes.result);
      return;
    }

    await client.mutation.createThread({
      input: {
        customerIdentifier: {
          customerId,
        },
        title: title,
        components: components,
        labelTypeIds,
      },
    });
  } catch (error) {
    console.error("Failed to send to Plain", error);
  }
}
