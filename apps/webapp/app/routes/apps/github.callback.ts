import type { LoaderArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { AppInstallationCallback } from "~/services/github/appInstallationCallback.server";
import { requireUserId } from "~/services/session.server";

const ParamSchema = z.object({
  code: z.string(),
  state: z.string(),
  installation_id: z.string(),
});

export async function loader({ request }: LoaderArgs) {
  await requireUserId(request);

  const url = new URL(request.url);
  const params = Object.fromEntries(url.searchParams.entries());

  const service = new AppInstallationCallback();

  const parsedParams = ParamSchema.safeParse(params);

  if (!parsedParams.success) {
    console.error(
      `[github.callback] Invalid params`,
      params,
      parsedParams.error
    );
    throw new Response("Failed to connect to GitHub", { status: 400 });
  }

  const result = await service.call(parsedParams.data);

  if (result) {
    const { authorization, templateId } = result;

    return redirect(
      `/orgs/${authorization.organization.slug}/templates/add${
        templateId ? `?templateId=${templateId}` : ""
      }`
    );
  } else {
    return redirect(`/`);
  }
}
