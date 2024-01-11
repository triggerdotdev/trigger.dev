export const obfuscateApiKey = (apiKey: string) => {
  const [prefix, slug, secretPart] = apiKey.split("_") as [string, string, string];
  return `${prefix}_${slug}_${"*".repeat(secretPart.length)}`;
};
