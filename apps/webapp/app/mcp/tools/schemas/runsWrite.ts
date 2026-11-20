import { RunMetadataChangeOperation } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import {
  operationsPreviewIssue,
  replacementPreviewIssue,
  tagsPreviewIssue,
} from "../format/runsEditPreview";
import { CommonRunsInput } from "./common";

const previewable =
  <T>(issue: (value: T) => string | undefined) =>
  (value: T, ctx: z.RefinementCtx) => {
    const message = issue(value);
    if (message) ctx.addIssue({ code: "custom", message });
  };

export const ResetRunIdempotencyKeyInput = CommonRunsInput;

export const UpdateRunMetadataInput = CommonRunsInput.extend({
  metadata: z
    .record(z.string(), z.any())
    .superRefine(previewable(replacementPreviewIssue))
    .describe("Replace the run's metadata with this object. Use operations to change single keys.")
    .optional(),
  operations: z
    .array(RunMetadataChangeOperation)
    .min(1)
    .superRefine(previewable(operationsPreviewIssue))
    .describe(
      "Operations applied in order: set, delete, append, remove, increment, or update (replaces all metadata with the given object)."
    )
    .optional(),
});

export type UpdateRunMetadataInput = z.output<typeof UpdateRunMetadataInput>;

export const AddRunTagsInput = CommonRunsInput.extend({
  tags: z
    .array(z.string().max(128, "Tags must be less than 128 characters"))
    .min(1)
    .superRefine(previewable(tagsPreviewIssue))
    .describe("Tags to add to the run. A run can have up to 10 tags of up to 128 characters."),
});

export type AddRunTagsInput = z.output<typeof AddRunTagsInput>;

export const RescheduleRunInput = CommonRunsInput.extend({
  delay: z
    .string()
    .describe(
      "When the delayed run should start, as a duration from now like 1h30m or an ISO 8601 date"
    ),
});

export type RescheduleRunInput = z.output<typeof RescheduleRunInput>;
