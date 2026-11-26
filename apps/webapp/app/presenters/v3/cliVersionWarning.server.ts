import * as semver from "semver";
import type { PrismaClientOrTransaction } from "~/db.server";
import { evaluateCliVersion, type DeployCliVersionPolicy } from "~/v3/cliVersionPolicy.server";

export type CliVersionWarning = {
  cliVersion: string;
  minimum: string;
  lastSupportedDay: string;
  enforced: boolean;
};

// Intl's en-GB short month for September is "Sept" on current ICU.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function lastSupportedDay(enforcedFrom: Date) {
  const day = new Date(enforcedFrom.getTime() - 24 * 60 * 60 * 1000);
  return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}

function warningFor(
  policy: DeployCliVersionPolicy,
  version: string | null | undefined
): CliVersionWarning | undefined {
  const cliVersion = version ? semver.valid(version) : null;
  if (!cliVersion) return undefined;

  const verdict = evaluateCliVersion(policy, cliVersion, new Date());
  if (verdict !== "warn" && verdict !== "reject") return undefined;

  return {
    cliVersion,
    minimum: policy.minimum,
    lastSupportedDay: lastSupportedDay(policy.enforcedFrom),
    enforced: verdict === "reject",
  };
}

// Initialize and worker upload each check their own recorded version, so either can trigger it.
export function cliVersionWarningFor(
  policy: DeployCliVersionPolicy | undefined,
  ...versions: Array<string | null | undefined>
): CliVersionWarning | undefined {
  if (!policy) return undefined;
  return versions
    .map((version) => warningFor(policy, version))
    .filter((warning): warning is CliVersionWarning => warning !== undefined)
    .sort((a, b) => semver.compare(a.cliVersion, b.cliVersion))[0];
}

export async function environmentCliVersionWarning(
  prisma: PrismaClientOrTransaction,
  {
    environmentId,
    policy,
    since,
  }: { environmentId: string; policy: DeployCliVersionPolicy | undefined; since: Date }
): Promise<CliVersionWarning | undefined> {
  if (!policy) return undefined;

  const recent = await prisma.workerDeployment.findMany({
    where: {
      environmentId,
      createdAt: { gte: since },
      OR: [{ cliVersion: { not: null } }, { worker: { cliVersion: { not: "unknown" } } }],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { cliVersion: true, worker: { select: { cliVersion: true } } },
  });

  const latest = recent.find((deployment) =>
    [deployment.cliVersion, deployment.worker?.cliVersion].some(
      (version) => version && semver.valid(version)
    )
  );
  return latest
    ? cliVersionWarningFor(policy, latest.cliVersion, latest.worker?.cliVersion)
    : undefined;
}
