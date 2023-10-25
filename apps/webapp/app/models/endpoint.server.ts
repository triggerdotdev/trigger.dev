import { RESPONSE_TIMEOUT_STATUS_CODES } from "~/consts";
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

export function detectResponseIsTimeout(response?: Response) {
  if (!response) {
    return false;
  }

  return (
    RESPONSE_TIMEOUT_STATUS_CODES.includes(response.status) ||
    response.headers.get("x-vercel-error") === "FUNCTION_INVOCATION_TIMEOUT"
  );
}
