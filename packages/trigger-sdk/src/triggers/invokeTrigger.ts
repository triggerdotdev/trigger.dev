import { TriggerMetadata } from "@trigger.dev/core";
import { TypeOf, ZodType, z } from "zod";
import { ParsedPayloadSchemaError } from "../errors.js";
import { Job } from "../job.js";
import { TriggerClient } from "../triggerClient.js";
import { EventSpecification, EventSpecificationExample, Trigger } from "../types.js";
import { formatSchemaErrors } from "../utils/formatSchemaErrors.js";

/** Configuration options for an InvokeTrigger */
type InvokeTriggerOptions<TSchema extends ZodType = z.ZodTypeAny> = {
  /** A [Zod](https://trigger.dev/docs/documentation/guides/zod) schema that defines the shape of the event payload.
   * The default is `z.any()` which is `any`.
   * */
  schema?: TSchema;
  examples?: EventSpecificationExample[];
};

export class InvokeTrigger<TSchema extends ZodType = z.ZodTypeAny>
  implements Trigger<EventSpecification<TypeOf<TSchema>, z.input<TSchema>>>
{
  #options: InvokeTriggerOptions<TSchema>;

  constructor(options: InvokeTriggerOptions<TSchema>) {
    this.#options = options;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "invoke",
    };
  }

  get event() {
    return {
      name: "invoke",
      title: "Manual Invoke",
      source: "trigger.dev",
      examples: this.#options.examples ?? [],
      icon: "trigger",
      parsePayload: (rawPayload: unknown) => {
        if (this.#options.schema) {
          const results = this.#options.schema.safeParse(rawPayload);

          if (!results.success) {
            throw new ParsedPayloadSchemaError(formatSchemaErrors(results.error.issues));
          }

          return results.data;
        }

        return rawPayload as any;
      },
      parseInvokePayload: (rawPayload: unknown) => {
        if (this.#options.schema) {
          const results = this.#options.schema.safeParse(rawPayload);

          if (!results.success) {
            throw new ParsedPayloadSchemaError(formatSchemaErrors(results.error.issues));
          }

          return results.data;
        }

        return rawPayload as any;
      },
    };
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<EventSpecification<ZodType<TSchema>>>, any>
  ): void {}

  get preprocessRuns() {
    return false;
  }

  async verifyPayload() {
    return { success: true as const };
  }
}

export function invokeTrigger<TSchema extends ZodType = z.ZodTypeAny>(
  options?: InvokeTriggerOptions<TSchema>
): Trigger<EventSpecification<TypeOf<TSchema>, z.input<TSchema>>> {
  return new InvokeTrigger(options ?? {});
}
