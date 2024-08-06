import { readPackageJSON } from "pkg-types";
import { pj } from "../pkg.js";

export async function readPackageJson() {
  return await readPackageJSON(pj);
}
