// The webapp keeps its own comparator: skew protection thresholds accept any number of segments.
/**
 * Order two deployment versions (`20261123.6`, or any dot-separated numbers such as a skew
 * protection threshold's `20261123.6.1`). Segments compare as numbers from the left; a missing
 * segment counts as 0, so `20261123` sorts before `20261123.1` and `20261123.6` equals
 * `20261123.6.0`. A segment that isn't a number compares as text.
 */
export function compareDeploymentVersions(versionA: string, versionB: string): number {
  const a = versionA.split(".");
  const b = versionB.split(".");

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const segmentA = a[i] ?? "0";
    const segmentB = b[i] ?? "0";
    const numA = Number(segmentA);
    const numB = Number(segmentB);

    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      if (segmentA !== segmentB) return segmentA < segmentB ? -1 : 1;
      continue;
    }

    if (numA !== numB) return numA < numB ? -1 : 1;
  }

  return 0;
}
