import { readPackageJSON } from "pkg-types";
import { packageDir } from "../packageDir.js";

export async function readPackageJson() {
  return await readPackageJSON(packageDir);
}
