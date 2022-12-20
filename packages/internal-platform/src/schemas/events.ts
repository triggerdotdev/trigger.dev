import { CustomEventSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";

export type CustomEvent = z.infer<typeof CustomEventSchema>;
