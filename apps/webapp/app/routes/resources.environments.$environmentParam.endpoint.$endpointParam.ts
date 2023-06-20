import { parse } from "@conform-to/zod";
import { ActionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  CreateEndpointError,
  CreateEndpointService,
} from "~/services/endpoints/createEndpoint.server";
import { IndexEndpointService } from "~/services/endpoints/indexEndpoint.server";
import { requireUserId } from "~/services/session.server";

const ParamsSchema = z.object({
  environmentParam: z.string(),
  endpointParam: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  const userId = await requireUserId(request);
  const { environmentParam, endpointParam } = ParamsSchema.parse(params);

  try {
    const service = new IndexEndpointService();
    const result = await service.call(endpointParam, "MANUAL");

    return json({ success: true });
  } catch (e) {
    return json({ success: false, error: e }, { status: 400 });
  }
}
