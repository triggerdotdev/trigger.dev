import { findPackageJson, loadPackageJson } from "package-json-from-dist";
export const pkg = loadPackageJson(__filename);
export const pj = findPackageJson(__filename);
