import { dereferenceSpec } from "core/schemas/schemaBuilder";
import rawSpec from "./slack_web_openapi_v2.json";
export const spec = dereferenceSpec(rawSpec);
