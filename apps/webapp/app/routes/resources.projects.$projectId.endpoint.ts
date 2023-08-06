import { parse } from "@conform-to/zod";
import { ActionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import {
  CreateEndpointError,
  CreateEndpointService,
} from "~/services/endpoints/createEndpoint.server";
import { requireUserId } from "~/services/session.server";
import { RuntimeEnvironmentTypeSchema } from "@trigger.dev/core";
import { env } from "process";
import { ValidateCreateEndpointService } from "~/services/endpoints/validateCreateEndpoint.server";

const ParamsSchema = z.object({
  projectId: z.string(),
});

export const bodySchema = z.object({
  environmentId: z.string(),
  url: z.string().url("Must be a valid URL"),
});

export async function action({ request, params }: ActionArgs) {
  const userId = await requireUserId(request);
  const { projectId } = ParamsSchema.parse(params);

  const formData = await request.formData();
  const submission = parse(formData, { schema: bodySchema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const environment = await prisma.runtimeEnvironment.findUnique({
      include: {
        organization: true,
        project: true,
      },
      where: {
        id: submission.value.environmentId,
      },
    });

    if (!environment) {
      submission.error.environmentId = "Environment not found";
      return json(submission);
    }

    console.log(submission);

    const service = new ValidateCreateEndpointService();
    const result = await service.call({
      url: submission.value.url,
      environment,
    });

    return json(submission);
  } catch (e) {
    if (e instanceof CreateEndpointError) {
      submission.error.url = e.message;
      return json(submission);
    }

    if (e instanceof Error) {
      submission.error.url = `${e.name}: ${e.message}`;
    } else {
      submission.error.url = "Unknown error";
    }

    return json(submission, { status: 400 });
  }
}
