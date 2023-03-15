import type { LoaderArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { z } from "zod";
import { StartAppInstallation } from "~/features/ee/projects/github/startAppInstallation.server";
import { requireUserId } from "~/services/session.server";

const SearchParamsSchema = z.object({
  redirectTo: z.string().default("/"),
  authorizationId: z.string().optional(),
});

export async function loader({ request, params }: LoaderArgs) {
  const userId = await requireUserId(request);
  const url = new URL(request.url);
  const { redirectTo, authorizationId } = SearchParamsSchema.parse(
    Object.fromEntries(url.searchParams.entries())
  );

  const service = new StartAppInstallation();

  const location = await service.call({
    userId,
    redirectTo,
    authorizationId,
  });

  return redirect(location ?? `/`);
}
