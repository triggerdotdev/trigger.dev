import { Attributes } from "@opentelemetry/api";
import { Accessory } from "../schemas/index.js";
import { flattenAttributes } from "./flattenAttributes.js";
import { SemanticInternalAttributes } from "../semanticInternalAttributes.js";

export function accessoryAttributes(accessory: Accessory): Attributes {
  return flattenAttributes(accessory, SemanticInternalAttributes.STYLE_ACCESSORY);
}
