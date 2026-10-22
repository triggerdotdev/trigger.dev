import type { ProjectAlertType, RuntimeEnvironmentType } from "@trigger.dev/database";
import type { PrismaClientOrTransaction } from "~/db.server";

export type AuthorizedChannel = {
  id: string;
  projectId: string;
  name: string;
  alertTypes: ProjectAlertType[];
  environmentTypes: RuntimeEnvironmentType[];
};

const ATTEMPTS = 3;

export async function writeAuthorizedChannel<T>(
  prisma: PrismaClientOrTransaction,
  where: { id: string; projectId: string },
  authorize: (environmentTypes: RuntimeEnvironmentType[]) => void,
  write: (channel: AuthorizedChannel) => Promise<T | null>
): Promise<{ found: false } | { found: true; result: T }> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const channel = await prisma.projectAlertChannel.findFirst({
      where,
      select: { id: true, projectId: true, name: true, alertTypes: true, environmentTypes: true },
    });
    if (!channel) {
      return { found: false };
    }
    authorize(channel.environmentTypes);
    const result = await write(channel);
    if (result !== null) {
      return { found: true, result };
    }
  }
  throw new Response("Alert channel changed, try again", { status: 409 });
}

export function authorizedChannelWhere(channel: AuthorizedChannel) {
  return {
    id: channel.id,
    projectId: channel.projectId,
    environmentTypes: { equals: channel.environmentTypes },
  };
}
