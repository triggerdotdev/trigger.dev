// The docs link no bigger payload: MAX_PAYLOAD_BYTES in apps/docs/lib/task-test.ts.
/** Largest payload a link can prefill on the Test page, in UTF-8 bytes of its JSON. */
export const MAX_PREFILL_PAYLOAD_BYTES = 4096;

const MAX_PARAM_LENGTH = Math.ceil(MAX_PREFILL_PAYLOAD_BYTES / 3) * 4;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * The Test page's `payload` search param (base64url of UTF-8 JSON, as the docs "Test in dashboard"
 * links send it), pretty-printed for the payload editor. A missing, oversized or non-JSON value
 * gives undefined and the page keeps its usual payload. It only fills the editor; nothing runs.
 */
export function testPayloadPrefill(url: URL): string | undefined {
  const param = url.searchParams.get("payload");
  if (!param || param.length > MAX_PARAM_LENGTH || !BASE64URL.test(param)) return undefined;

  const bytes = Buffer.from(param, "base64url");
  if (bytes.length > MAX_PREFILL_PAYLOAD_BYTES) return undefined;

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}
