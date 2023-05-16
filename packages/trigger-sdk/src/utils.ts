export function slugifyId(input: string): string {
  // Replace any number of spaces with a single dash
  const replaceSpacesWithDash = input.toLowerCase().replace(/\s+/g, "-");

  // Remove any non-URL-safe characters
  const removeNonUrlSafeChars = replaceSpacesWithDash.replace(
    /[^a-zA-Z0-9-._~]/g,
    ""
  );

  return removeNonUrlSafeChars;
}
