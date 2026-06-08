// Runtime VALUE imports from `ai`, isolated behind a paired ESM/CJS shim.
//
// `ai@7` is ESM-only (no `require` export). Under NodeNext + TS < 5.8 a value
// import of an ESM-only package emitted to a CJS file raises TS1479, which
// would break the SDK's CommonJS build. tshy maps `ai-runtime-cjs.cts` -> the
// CJS build and this `.ts` -> the ESM build, so each dialect gets the right
// form. `require(esm)` is stable on Node >=20.19 / >=22.12 (both our targets),
// so the CJS variant works at runtime. Mirrors `imports/uncrypto{,-cjs.cts}`.
//
// VALUES only — type-only imports from `ai` erase and don't trip TS1479, so
// they stay as direct `import type { … } from "ai"` at their use sites.

// @ts-ignore
import {
  convertToModelMessages,
  dynamicTool,
  generateId,
  getToolName,
  isToolUIPart,
  jsonSchema,
  readUIMessageStream,
  stepCountIs,
  tool,
  zodSchema,
} from "ai";

// @ts-ignore
export {
  convertToModelMessages,
  dynamicTool,
  generateId,
  getToolName,
  isToolUIPart,
  jsonSchema,
  readUIMessageStream,
  stepCountIs,
  tool,
  zodSchema,
};
