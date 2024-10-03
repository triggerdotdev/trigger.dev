import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { PlainClient, uiComponent } from "@team-plain/typescript-sdk";
import { inspect } from "util";
import { env } from "~/env.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";

let client: PlainClient | undefined;

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const path = formData.get("path") as string;
  const reasons = formData.getAll("reason") as string[];
  const message = formData.get("message") as string;

  try {
    if (!env.PLAIN_API_KEY) {
      console.error("PLAIN_API_KEY is not set");
      return json({ error: "PLAIN_API_KEY is not set" }, { status: 500 });
    }

    client = new PlainClient({
      apiKey: env.PLAIN_API_KEY,
    });

    const upsertCustomerRes = await client.upsertCustomer({
      identifier: {
        emailAddress: user.email,
      },
      onCreate: {
        externalId: user.id,
        fullName: user.name ?? "",
        email: {
          email: user.email,
          isVerified: true,
        },
      },
      onUpdate: {
        externalId: { value: user.id },
        fullName: { value: user.name ?? "" },
        email: {
          email: user.email,
          isVerified: true,
        },
      },
    });

    if (upsertCustomerRes.error) {
      console.error(
        inspect(upsertCustomerRes.error, {
          showHidden: false,
          depth: null,
          colors: true,
        })
      );
      return json({ error: upsertCustomerRes.error.message }, { status: 400 });
    }

    // Only create a thread if there are reasons or a message
    if (reasons.length > 0 || message) {
      const createThreadRes = await client.createThread({
        customerIdentifier: {
          customerId: upsertCustomerRes.data.customer.id,
        },
        title: "Plan cancelation feedback",
        components: [
          uiComponent.text({
            text: `${user.name} (${user.email}) just canceled their plan.`,
          }),
          uiComponent.divider({ spacingSize: "M" }),
          ...(reasons.length > 0
            ? [
                uiComponent.spacer({ size: "L" }),
                uiComponent.text({
                  size: "S",
                  color: "ERROR",
                  text: "Reasons:",
                }),
                uiComponent.text({
                  text: reasons.join(", "),
                }),
              ]
            : []),
          ...(message
            ? [
                uiComponent.spacer({ size: "L" }),
                uiComponent.text({
                  size: "S",
                  color: "ERROR",
                  text: "Comment:",
                }),
                uiComponent.text({
                  text: message,
                }),
              ]
            : []),
        ],
      });

      if (createThreadRes.error) {
        console.error(
          inspect(createThreadRes.error, {
            showHidden: false,
            depth: null,
            colors: true,
          })
        );
        return json({ error: createThreadRes.error.message }, { status: 400 });
      }
    }

    return redirectWithSuccessMessage(path, request, "Your plan has been successfully canceled.");
  } catch (e) {
    return json({ error: "An unexpected error occurred" }, { status: 500 });
  }
}
