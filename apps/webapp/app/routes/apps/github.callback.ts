import { LoaderArgs, redirect } from "@remix-run/server-runtime";
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

  const result = await service.call(ParamSchema.parse(params));

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
