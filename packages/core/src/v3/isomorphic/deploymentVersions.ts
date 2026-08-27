export function compareDeploymentVersions(versionA: string, versionB: string): number {
  const [dateA = "", numberA] = versionA.split(".");
  const [dateB = "", numberB] = versionB.split(".");

  if (dateA < dateB) {
    return -1;
  }

  if (dateA > dateB) {
    return 1;
  }

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
