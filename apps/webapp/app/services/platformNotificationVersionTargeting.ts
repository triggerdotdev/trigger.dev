import * as semver from "semver";

export function normalizeExactSemVer(value: string): string | null {
  const trimmed = value.trim();
  const parsed = semver.parse(trimmed);

  if (!parsed) return null;

  const normalized = `${parsed.version}${
    parsed.build.length > 0 ? `+${parsed.build.join(".")}` : ""
  }`;

  return normalized === trimmed ? normalized : null;
}

export function isCliVersionEligible(
  minimumCliVersion: string | undefined,
  cliVersion: string | undefined
): boolean {
  if (minimumCliVersion === undefined) return true;

  const normalizedMinimum = normalizeExactSemVer(minimumCliVersion);
  if (!normalizedMinimum || cliVersion === undefined) return false;

  const normalizedCliVersion = normalizeExactSemVer(cliVersion);
  if (!normalizedCliVersion) return false;

  return semver.gte(normalizedCliVersion, normalizedMinimum);
}
