import { TriggerTracer } from "@trigger.dev/core/v3";
import * as packageJson from "../../package.json";
import { trace } from "@opentelemetry/api";

export const tracer = new TriggerTracer(trace.getTracer("@trigger.dev/sdk", packageJson.version));
