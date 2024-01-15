import { type PackageJson } from "type-fest";
import path from "path";
import { PKG_ROOT } from "../consts";
import { readJSONFileSync } from "./fileSystem";

export function getVersion() {
  const packageJsonPath = path.join(PKG_ROOT, "package.json");

  const packageJsonContent = readJSONFileSync(packageJsonPath) as PackageJson;

  return packageJsonContent.version ?? "1.0.0";
}
