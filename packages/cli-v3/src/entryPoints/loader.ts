import { register } from "node:module";
import { createAddHookMessageChannel } from "import-in-the-middle";

const { registerOptions, waitForAllMessagesAcknowledged } = createAddHookMessageChannel();

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
register("import-in-the-middle/hook.mjs", import.meta.url, registerOptions);

// Ensure that the loader has acknowledged all the modules
// before we allow execution to continue
await waitForAllMessagesAcknowledged;
