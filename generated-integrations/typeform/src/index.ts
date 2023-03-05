import { getTriggerRun } from "@trigger.dev/sdk";
import type { TriggerEvent } from "@trigger.dev/sdk";
import { z } from "zod";
import { FormResponseInput, FormResponseOutput, Prettify } from "./types";

const formResponseEventSchema = z.object({
  "event_id": z.string().describe("The ID of the event that triggered this webhook"), "event_type": z.literal("form_response").describe("The type of event, always \"form_response\""), "form_response": z.object({
    "calculated": z.object({ "score": z.number().describe("The score of the response, if the form has a score field") }).optional(), "variables": z.array(z.any().superRefine((x, ctx) => {
      const schemas = [z.object({ "id": z.string().describe("The ID of the variable"), "type": z.literal("text").describe("The type of the variable"), "text": z.string().describe("The value of the variable") }), z.object({ "id": z.string().describe("The ID of the variable"), "type": z.literal("number").describe("The type of the variable"), "number": z.number().describe("The value of the variable") })];
      const errors = schemas.reduce(
        (errors: z.ZodError[], schema) =>
          ((result) => ("error" in result ? [...errors, result.error] : errors))(
            schema.safeParse(x)
          ),
        []
      );
      if (schemas.length - errors.length !== 1) {
        ctx.addIssue({
          path: ctx.path,
          code: "invalid_union",
          unionErrors: errors,
          message: "Invalid input: Should pass single schema",
        });
      }
    })).optional(), "hidden": z.record(z.any()).optional(), "form_id": z.string().describe("The ID of the form that was submitted"), "token": z.string().describe("The unique token for this response"), "submitted_at": z.string().describe("The date and time the response was submitted"), "landed_at": z.string().describe("The date and time the respondent landed on the form"), "definition": z.object({ "endings": z.array(z.object({ "id": z.string().describe("The ID of the ending"), "ref": z.string().describe("A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to."), "title": z.string().describe("The title of the ending"), "type": z.string().describe("The type of the ending") }).catchall(z.any())).optional(), "id": z.string().describe("The ID of the form"), "title": z.string().describe("The title of the form"), "fields": z.array(z.object({ "id": z.string().describe("The ID of the field"), "title": z.string().describe("The title of the field"), "type": z.string().describe("The type of the field"), "ref": z.string().describe("A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to."), "allow_multiple_selectiors": z.boolean().describe("Whether or not the field allows multiple selections"), "allow_other_choice": z.boolean().describe("Whether or not the field allows an 'other' choice"), "choices": z.array(z.object({ "label": z.string().describe("The label of the choice"), "id": z.string().describe("The ID of the choice") })) })) }), "answers": z.array(z.any()), "ending": z.object({ "id": z.string().describe("The ID of the ending"), "ref": z.string().describe("A reference to the field – this will be different on every response unless you used the Create API to create the field. In that case, it will be what you set it to.") }).catchall(z.any())
  })
})

/** A form response was submitted */
function formResponseEvent(
  /** The params for this call */
  params: Prettify<FormResponseInput>
): TriggerEvent<typeof formResponseEventSchema> {
  return {
    metadata: {
      type: "INTEGRATION_WEBHOOK",
      service: "typeform",
      name: "form_response",
      key: `${params.form_id}`,
      filter: {
        service: ["typeform"],
        event: ["form_response"],
      },
      source: params,
    },
    schema: formResponseEventSchema,
  };
}

export const events = { formResponseEvent };
