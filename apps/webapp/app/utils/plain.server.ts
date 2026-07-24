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
  organizationId?: string;
  organizationName?: string;
};

export async function sendToPlain({
  userId,
  email,
  name,
  title,
  components,
  labelTypeIds,
  organizationId,
  organizationName,
}: Input) {
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

    // Attribute the thread to the org so support data can be rolled up per org: the tenant is
    // keyed by externalId = org_id. Isolated in its own try/catch, and the thread's
    // tenantIdentifier is gated on success — so a tenant failure (e.g. an API key without
    // tenant scope) downgrades to "no attribution" instead of dropping the thread. The
    // customer's own externalId (User.id, used by the customer cards + impersonation link) is
    // left untouched.
    let tenantLinked = false;
    if (organizationId) {
      try {
        await client.mutation.upsertTenant({
          input: {
            identifier: { externalId: organizationId },
            externalId: organizationId,
            name: organizationName ?? organizationId,
          },
        });
        await client.mutation.addCustomerToTenants({
          input: {
            customerIdentifier: { customerId },
            tenantIdentifiers: [{ externalId: organizationId }],
          },
        });
        tenantLinked = true;
      } catch (error) {
        console.error("Failed to link Plain customer to org tenant", error);
      }
    }

    await client.mutation.createThread({
      input: {
        customerIdentifier: {
          customerId,
        },
        title: title,
        components: components,
        labelTypeIds,
        tenantIdentifier: tenantLinked ? { externalId: organizationId } : undefined,
      },
    });
  } catch (error) {
    console.error("Failed to send to Plain", error);
  }
}
