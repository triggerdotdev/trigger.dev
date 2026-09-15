const ADDITIONAL_API_KEY_PATTERN = /^tr_(dev|stg|prod|preview)_sk_[0-9a-zA-Z]{24}$/;

/**
 * Returns whether a key has the additional environment API key format.
 *
 * This is only a routing hint. It must never be used as a security boundary;
 * servers authenticate additional keys by resolving their stored hash.
 */
export function isAdditionalApiKey(key: string): boolean {
  return ADDITIONAL_API_KEY_PATTERN.test(key);
}
