import { findPackageJson, loadPackageJson } from "package-json-from-dist";
//@ts-ignore
export const pkg = loadPackageJson(import.meta.url ?? __filename); // ?? __filename is a hack to get the webapp to build
//@ts-ignore
export const pj = findPackageJson(import.meta.url ?? __filename); // ?? __filename is a hack to get the webapp to build
