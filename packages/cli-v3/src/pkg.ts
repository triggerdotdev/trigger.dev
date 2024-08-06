import { findPackageJson, loadPackageJson } from "package-json-from-dist";
//@ts-ignore
export const pkg = loadPackageJson(import.meta.url);
//@ts-ignore
export const pj = findPackageJson(import.meta.url);
