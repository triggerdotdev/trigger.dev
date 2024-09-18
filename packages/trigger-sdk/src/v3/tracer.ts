import { TriggerTracer } from "@trigger.dev/core/v3";
import { VERSION } from "../version.js";

export const tracer = new TriggerTracer({ name: "@trigger.dev/sdk", version: VERSION });
