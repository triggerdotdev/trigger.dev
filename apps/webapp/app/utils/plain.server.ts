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

  // Best-effort support side-effect. Only transport/auth errors throw (caught below); business
  // and validation failures come back in each mutation's `result.error`, so we check those inline.
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

    if (upsertCustomerRes.error || !upsertCustomerRes.customer?.id) {
      console.error("Failed to upsert customer in Plain", upsertCustomerRes.error);
      return;
    }
    const customerId = upsertCustomerRes.customer.id;

    // Attribute the thread to the org so support data can be rolled up per org: the tenant is
    // keyed by externalId = org_id. Isolated in its own try/catch, and the thread's
    // tenantIdentifier is gated on success — so a tenant failure (e.g. an API key without
    // tenant scope) downgrades to "no attribution" instead of dropping the thread. The
    // customer's own externalId (User.id, used by the customer cards + impersonation link) is
    // left untouched.
    let tenantLinked = false;
    if (organizationId) {
      try {
        const tenantRes = await client.mutation.upsertTenant({
          input: {
            identifier: { externalId: organizationId },
            externalId: organizationId,
            name: organizationName ?? organizationId,
          },
        });
        // Only link + attribute if the tenant genuinely upserted — a mutation error comes back in
        // `.error` (not thrown), and stamping the thread with a tenant that wasn't created would
        // make createThread itself fail.
        const membershipRes = tenantRes.error
          ? undefined
          : await client.mutation.addCustomerToTenants({
              input: {
                customerIdentifier: { customerId },
                tenantIdentifiers: [{ externalId: organizationId }],
              },
            });
        if (tenantRes.error) {
          console.error("Failed to upsert Plain tenant", tenantRes.error);
        } else if (membershipRes?.error) {
          console.error("Failed to link Plain customer to tenant", membershipRes.error);
        } else {
          tenantLinked = true;
        }
      } catch (error) {
        console.error("Failed to link Plain customer to org tenant", error);
      }
    }

    const threadRes = await client.mutation.createThread({
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
    if (threadRes.error) {
      console.error("Failed to create Plain thread", threadRes.error);
    }
  } catch (error) {
    console.error("Failed to send to Plain", error);
  }
}
