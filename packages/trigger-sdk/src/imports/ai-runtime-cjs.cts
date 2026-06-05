// CJS variant of ./ai-runtime.ts — tshy swaps this in for the CommonJS build.
// `require("ai")` of an ESM-only package is supported on Node >=20.19 / >=22.12.

// @ts-ignore
const ai = require("ai");

// @ts-ignore
module.exports.convertToModelMessages = ai.convertToModelMessages;
// @ts-ignore
module.exports.dynamicTool = ai.dynamicTool;
// @ts-ignore
module.exports.generateId = ai.generateId;
// @ts-ignore
module.exports.getToolName = ai.getToolName;
// @ts-ignore
module.exports.isToolUIPart = ai.isToolUIPart;
// @ts-ignore
module.exports.jsonSchema = ai.jsonSchema;
// @ts-ignore
module.exports.readUIMessageStream = ai.readUIMessageStream;
// @ts-ignore
module.exports.stepCountIs = ai.stepCountIs;
// @ts-ignore
module.exports.tool = ai.tool;
// @ts-ignore
module.exports.zodSchema = ai.zodSchema;
