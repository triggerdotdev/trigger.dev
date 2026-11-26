// Kept out of route.tsx: the org layout imports this, and importing the route module would
// pull the whole concurrency page (charts included) into every page's JavaScript.
export function isEnvironmentPauseResumeFormSubmission(
  formMethod: string | undefined,
  formData: FormData | undefined
) {
  if (!formMethod || !formData) {
    return false;
  }

  return (
    formMethod.toLowerCase() === "post" &&
    (formData.get("action") === "environment-pause" ||
      formData.get("action") === "environment-resume")
  );
}
