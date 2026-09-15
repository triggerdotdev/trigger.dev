import { type PrismaClientOrTransaction } from "~/db.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { NEW_SCHEDULE_DEFAULT_WINDOW_DURATION_SECONDS } from "~/v3/scheduleWindow.server";

/**
 * The default spread window a schedule created right now in this organization would capture, in
 * seconds, or `null` when the org rollout flag is off.
 *
 * This is a new-schedule enrollment gate, NOT a hot-path execution check. Resolve it once per
 * imperative creation request and once per declarative project/environment sync — never once per
 * schedule inside a deployment loop, and never inside the schedule engine. A schedule captures
 * whatever this returned at creation time, permanently; later flag flips do not backfill or
 * un-enroll existing rows.
 */
export async function resolveNewScheduleDefaultWindowSeconds(
  prisma: PrismaClientOrTransaction,
  organizationId: string
): Promise<number | null> {
  const organization = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { featureFlags: true },
  });

  const flag = makeFlag(prisma);
  const enabled = await flag({
    key: FEATURE_FLAG.scheduleDefaultWindowEnabled,
    defaultValue: false,
    overrides: (organization?.featureFlags as Record<string, unknown>) ?? {},
  });

  return enabled ? NEW_SCHEDULE_DEFAULT_WINDOW_DURATION_SECONDS : null;
}
