import { Webhook } from "@trigger.dev/core/v3";
import { subtle } from "../imports/uncrypto.js";

/**
 * The type of error thrown when a webhook fails to parse or verify
 */
export class WebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookError";
  }
}

/** Header name used for webhook signatures */
const SIGNATURE_HEADER_NAME = "x-trigger-signature-hmacsha256";

/**
 * Options for constructing a webhook event
 */
type ConstructEventOptions = {
  /** Raw payload as string or Buffer */
  payload: string | Buffer;
  /** Signature header as string, Buffer, or string array */
  header: string | Buffer | Array<string>;
};

/**
 * Interface describing the webhook utilities
 */
interface Webhooks {
  /**
   * Constructs and validates a webhook event from an incoming request
   * @param request - Either a Request object or ConstructEventOptions containing the payload and signature
   * @param secret - Secret key used to verify the webhook signature
   * @returns Promise resolving to a validated AlertWebhook object
   * @throws {WebhookError} If validation fails or payload can't be parsed
   *
   * @example
   * // Using with Request object
   * const event = await webhooks.constructEvent(request, "webhook_secret");
   *
   * @example
   * // Using with manual options
   * const event = await webhooks.constructEvent({
   *   payload: rawBody,
   *   header: signatureHeader
   * }, "webhook_secret");
   */
  constructEvent(request: ConstructEventOptions | Request, secret: string): Promise<Webhook>;

  /** Header name used for webhook signatures */
  SIGNATURE_HEADER_NAME: string;
}

/**
 * Webhook utilities for handling incoming webhook requests
 */
export const webhooks: Webhooks = {
  constructEvent,
  SIGNATURE_HEADER_NAME,
};

async function constructEvent(
  request: ConstructEventOptions | Request,
  secret: string
): Promise<Webhook> {
  let payload: string;
  let signature: string;

  if (request instanceof Request) {
    if (!secret) {
      throw new WebhookError("Secret is required when passing a Request object");
    }

    const signatureHeader = request.headers.get(SIGNATURE_HEADER_NAME);
    if (!signatureHeader) {
      throw new WebhookError("No signature header found");
    }
    signature = signatureHeader;

    payload = await request.text();
  } else {
    payload = request.payload.toString();

    if (Array.isArray(request.header)) {
      throw new WebhookError("Signature header cannot be an array");
    }
    signature = request.header.toString();
  }

  // Verify the signature
  const isValid = await verifySignature(payload, signature, secret);

  if (!isValid) {
    throw new WebhookError("Invalid signature");
  }

  // Parse and validate the payload
  try {
    const jsonPayload = JSON.parse(payload);
    const parsedPayload = Webhook.parse(jsonPayload);
    return parsedPayload;
  } catch (error) {
    if (error instanceof Error) {
      throw new WebhookError(`Webhook parsing failed: ${error.message}`);
    }
    throw new WebhookError("Webhook parsing failed");
  }
}

/**
 * Verifies the signature of a webhook payload
 * @param payload - Raw payload string to verify
 * @param signature - Expected signature to check against
 * @param secret - Secret key used to generate the signature
 * @returns Promise resolving to boolean indicating if signature is valid
 * @throws {WebhookError} If signature verification process fails
 *
 * @example
 * const isValid = await verifySignature(
 *   '{"event": "test"}',
 *   "abc123signature",
 *   "webhook_secret"
 * );
 */
async function verifySignature(
  payload: string,
  signature: string,
  secret: string
): Promise<boolean> {
  try {
    if (!secret) {
      throw new WebhookError("Secret is required for signature verification");
    }

    // Convert the payload and secret to buffers
    const hashPayload = Buffer.from(payload, "utf-8");
    const hmacSecret = Buffer.from(secret, "utf-8");

    // Import the secret key
    const key = await subtle.importKey(
      "raw",
      hmacSecret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    // Calculate the expected signature
    const actualSignature = await subtle.sign("HMAC", key, hashPayload);
    const actualSignatureHex = Buffer.from(actualSignature).toString("hex");

    // Compare signatures using timing-safe comparison
    return timingSafeEqual(signature, actualSignatureHex);
  } catch (error) {
    throw new WebhookError("Signature verification failed");
  }
}

// Timing-safe comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
