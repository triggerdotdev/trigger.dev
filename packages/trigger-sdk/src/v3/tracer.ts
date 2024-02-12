import { TriggerTracer } from "@trigger.dev/core/v3";
import * as packageJson from "../../package.json";

export const tracer = new TriggerTracer({ name: "@trigger.dev/sdk", version: packageJson.version });
