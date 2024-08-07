import { TriggerTracer } from "@trigger.dev/core/v3";
import { pkg } from "../pkg.js";

export const tracer = new TriggerTracer({ name: "@trigger.dev/sdk", version: pkg.version });
