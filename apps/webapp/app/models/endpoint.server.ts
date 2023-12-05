import { VERCEL_RESPONSE_TIMEOUT_STATUS_CODES } from "~/consts";
import { prisma } from "~/db.server";
import { Prettify } from "~/lib.es5";

export type ExtendedEndpoint = Prettify<Awaited<ReturnType<typeof findEndpoint>>>;

export async function findEndpoint(id: string) {
  return await prisma.endpoint.findUniqueOrThrow({
    where: {
      id,
    },
    include: {
      environment: {
        include: {
          project: true,
          organization: true,
        },
      },
    },
  });
}

export function detectResponseIsTimeout(rawBody: string, response?: Response) {
  if (!response) {
    return false;
  }

  if (isResponseVercelTimeout(response)) {
    return true;
  }

  return isResponseCloudflareTimeout(rawBody, response);
}

function isResponseCloudflareTimeout(rawBody: string, response: Response) {
  return (
    response.status === 503 &&
    rawBody.includes("Worker exceeded resource limits") &&
    typeof response.headers.get("cf-ray") === "string"
  );
}

function isResponseVercelTimeout(response: Response) {
  return (
    VERCEL_RESPONSE_TIMEOUT_STATUS_CODES.includes(response.status) ||
    response.headers.get("x-vercel-error") === "FUNCTION_INVOCATION_TIMEOUT"
  );
}
