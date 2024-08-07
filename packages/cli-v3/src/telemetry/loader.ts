import { register } from "node:module";

type ImportHookData = {
  include?: string[];
  exclude?: string[];
};

const data: ImportHookData = {};

if (typeof process.env.OTEL_IMPORT_HOOK_INCLUDES === "string") {
  data.include = process.env.OTEL_IMPORT_HOOK_INCLUDES.split(",");
}

if (typeof process.env.OTEL_IMPORT_HOOK_EXCLUDES === "string") {
  data.exclude = process.env.OTEL_IMPORT_HOOK_EXCLUDES.split(",");
}

// @ts-ignore
register("import-in-the-middle/hook.mjs", import.meta.url, {
  // @ts-ignore
  parentURL: import.meta.url,
  data,
});
