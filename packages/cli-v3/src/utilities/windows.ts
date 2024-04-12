export const isWindows = process.platform === "win32";

export function escapeImportPath(path: string) {
  return isWindows ? path.replaceAll("\\", "\\\\") : path;
}
