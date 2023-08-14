export function getPackageName(inputString: string): string {
  const packageName = inputString.split("/")[1];
  return packageName ?? "";
}
