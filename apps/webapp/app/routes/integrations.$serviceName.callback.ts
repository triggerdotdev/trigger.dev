import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import z from "zod";
import { redirectBackWithErrorMessage } from "~/models/message.server";
import { OrgIntegrationRepository } from "~/models/orgIntegration.server";
import { requireUserId } from "~/services/session.server";
import { requestUrl } from "~/utils/requestUrl.server";
import { CreateOrgIntegrationService } from "~/v3/services/createOrgIntegration.server";

const URLSearchSchema = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const ParamsSchema = z.object({
  serviceName: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  if (request.method.toUpperCase() !== "GET") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const userId = await requireUserId(request);

  const url = requestUrl(request);

  const parsedSearchParams = URLSearchSchema.safeParse(Object.fromEntries(url.searchParams));

  if (!parsedSearchParams.success) {
    // TODO: this needs to lookup the redirect url in the cookies
    throw new Response("Invalid params", { status: 400 });
  }

  if (parsedSearchParams.data.error) {
    // TODO: this needs to lookup the redirect url in the cookies
    throw new Response(parsedSearchParams.data.error, { status: 400 });
  }

  if (!parsedSearchParams.data.code || !parsedSearchParams.data.state) {
    throw new Response("Invalid params", { status: 400 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    throw new Response("Invalid params", { status: 400 });
  }

  const service = new CreateOrgIntegrationService();

  const integration = await service.call(
    userId,
    parsedSearchParams.data.state,
    parsedParams.data.serviceName,
    parsedSearchParams.data.code
  );

  if (integration) {
    return await OrgIntegrationRepository.redirectAfterAuth(request);
  }

  return redirectBackWithErrorMessage(request, "Failed to connect to the service");
}
