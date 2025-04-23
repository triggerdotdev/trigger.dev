// Compares two versions of a deployment, like 20250208.1 and 20250208.2
// Returns -1 if versionA is older than versionB, 0 if they are the same, and 1 if versionA is newer than versionB
export function compareDeploymentVersions(versionA: string, versionB: string) {
  const [dateA, numberA] = versionA.split(".");
  const [dateB, numberB] = versionB.split(".");

  if (dateA < dateB) {
    return -1;
  }

  if (dateA > dateB) {
    return 1;
  }

  // Convert to numbers before comparing
  const numA = Number(numberA);
  const numB = Number(numberB);

  if (numA < numB) {
    return -1;
  }

  if (numA > numB) {
    return 1;
  }

  return 0;
}
