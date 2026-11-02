/**
 * Internal, sticky discovery marker. Producers hold the run's lifecycle lock while marking it;
 * attempt annotation stamps use that same lock, so a stamp cannot overwrite a concurrent mark.
 * This is deliberately separate from the SDK-consumed RunAnnotations schema.
 */
export function hasStoreWaitpoints(annotations: unknown): boolean {
  return (
    typeof annotations === "object" &&
    annotations !== null &&
    !Array.isArray(annotations) &&
    (annotations as Record<string, unknown>).waitpointsOnStore === true
  );
}
