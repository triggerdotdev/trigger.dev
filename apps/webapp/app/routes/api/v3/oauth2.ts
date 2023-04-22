import { ActionArgs, redirect } from "@remix-run/server-runtime";
import z from "zod";
import { APIAuthenticationRepository } from "~/services/externalApis/apiAuthenticationRepository.server";

const FormSchema = z
  .object({
    organizationId: z.string(),
    api: z.string(),
    authenticationMethodKey: z.string(),
  })
  .passthrough();

export async function action({ request }: ActionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const formData = await request.formData();
  const formEntries = Object.fromEntries(formData.entries());

  const { organizationId, api, authenticationMethodKey } =
    FormSchema.parse(formEntries);

  const scopes = Object.entries(formEntries)
    .filter(([key]) => key.startsWith("scopes["))
    .filter(([_, value]) => value === "on")
    .flatMap(([key]) => key.replace("scopes[", "").replace("]", ""));

  const repository = new APIAuthenticationRepository(organizationId);
  const redirectUrl = await repository.createConnectionAttempt({
    organizationId,
    apiIdentifier: api,
    authenticationMethodKey,
    scopes,
  });

  return redirect(redirectUrl);
}
