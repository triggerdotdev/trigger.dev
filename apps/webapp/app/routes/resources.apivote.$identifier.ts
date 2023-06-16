import { ActionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { ApiVoteService } from "~/services/apiVote.server";
import { requireUserId } from "~/services/session.server";

const ParamsSchema = z.object({
  identifier: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  const userId = await requireUserId(request);
  const { identifier } = ParamsSchema.parse(params);

  const service = new ApiVoteService();

  try {
    const result = await service.call({ userId, identifier });
    return json(result);
  } catch (e) {
    return json(e, { status: 400 });
  }
}
