// Obfuscate the API key (will be in the format tr_dev_XXXX)
export function renderApiKey(apiKey: string): string {
  return apiKey.replace(/tr_dev_[a-zA-Z0-9]{6}/g, "tr_dev_********");
}
