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

/** Standard Webhooks spec header carrying the unique message id */
export const STANDARD_WEBHOOKS_ID_HEADER_NAME = "webhook-id";

/** Standard Webhooks spec header carrying the unix-timestamp at which the message was sent */
export const STANDARD_WEBHOOKS_TIMESTAMP_HEADER_NAME = "webhook-timestamp";

/** Standard Webhooks spec header carrying one or more space-separated `v1,<base64-hmac>` signatures */
export const STANDARD_WEBHOOKS_SIGNATURE_HEADER_NAME = "webhook-signature";

/** Signature version we currently accept */
export const STANDARD_WEBHOOKS_SIGNATURE_VERSION = "v1";

/** Default tolerance window for the anti-replay check, in seconds */
export const STANDARD_WEBHOOKS_TOLERANCE_SECONDS = 300;

/**
 * Options accepted by {@link StandardWebhooks.verify}.
 */
export type VerifyStandardWebhooksOptions = {
  /**
   * Maximum allowed age of the webhook in seconds. The age is derived from the
   * `webhook-timestamp` header compared against the current time. Defaults to
   * {@link STANDARD_WEBHOOKS_TOLERANCE_SECONDS}. Pass `0` to disable the
   * anti-replay check entirely.
   */
  tolerance?: number;
};

/**
 * Result returned by {@link StandardWebhooks.verify}.
 *
 * - `payload`: the parsed JSON body.
 * - `raw`: the raw request body as text, useful for replaying or auditing.
 */
export type VerifyStandardWebhooksResult = {
  payload: unknown;
  raw: string;
};

/**
 * Interface describing the Standard Webhooks verification utilities.
 */
interface StandardWebhooks {
  /**
   * Verifies the signature on an incoming Standard Webhooks request and
   * returns the parsed JSON body alongside the raw text that was signed.
   *
   * The `secret` is the base64-encoded shared secret that the sender used
   * to sign the request — the same value the sender gets from their
   * provider dashboard. Headers are matched case-insensitively per the
   * Fetch API Request contract.
   *
   * @param request - The incoming webhook request.
   * @param secret - Base64-encoded shared secret.
   * @param options - Optional behavior overrides.
   * @returns The parsed payload and the raw body text.
   * @throws {WebhookError} If any of the three spec headers are missing, the
   *   signature version is unsupported, the signature does not match, the
   *   secret is empty, the timestamp is outside the tolerance window, or
   *   the body is not valid JSON.
   *
   * @example
   * // Express handler
   * app.post("/webhooks/stripe", async (req, res) => {
   *   try {
   *     const { payload, raw } = await standardWebhooks.verify(
   *       req as unknown as Request,
   *       process.env.STRIPE_WEBHOOK_SECRET!,
   *     );
   *     console.log("event:", payload.type, "body was:", raw);
   *     res.sendStatus(200);
   *   } catch (err) {
   *     if (err instanceof WebhookError) {
   *       res.status(400).send(err.message);
   *       return;
   *     }
   *     throw err;
   *   }
   * });
   *
   * @example
   * // Disable anti-replay (NOT recommended in production)
   * await standardWebhooks.verify(request, secret, { tolerance: 0 });
   */
  verify(
    request: Request,
    secret: string,
    options?: VerifyStandardWebhooksOptions
  ): Promise<VerifyStandardWebhooksResult>;

  /** Default anti-replay tolerance in seconds (also exported as {@link STANDARD_WEBHOOKS_TOLERANCE_SECONDS}). */
  TOLERANCE_SECONDS: number;

  /** Header name carrying the unique message id. Mirror of {@link STANDARD_WEBHOOKS_ID_HEADER_NAME}. */
  ID_HEADER_NAME: string;

  /** Header name carrying the unix timestamp the message was sent. Mirror of {@link STANDARD_WEBHOOKS_TIMESTAMP_HEADER_NAME}. */
  TIMESTAMP_HEADER_NAME: string;

  /** Header name carrying one or more `v1,<base64-hmac>` signatures. Mirror of {@link STANDARD_WEBHOOKS_SIGNATURE_HEADER_NAME}. */
  SIGNATURE_HEADER_NAME: string;
}

/**
 * Utilities for verifying incoming webhooks that follow the Standard Webhooks
 * specification (https://github.com/standard-webhooks/standard-webhooks),
 * used by providers like Stripe, Svix, and ngrok.
 *
 * The shared shape is straightforward: a provider signs
 * `${webhook-id}.${webhook-timestamp}.${raw-body}` with HMAC-SHA256 using a
 * shared secret, and ships the result plus the id and timestamp as three
 * headers. `verify` reverses the process and returns the parsed body so you
 * can dispatch on it.
 *
 * @example
 * // Basic usage in a Next.js route handler
 * import { standardWebhooks, WebhookError } from "@trigger.dev/sdk";
 *
 * export async function POST(request: Request) {
 *   try {
 *     const { payload } = await standardWebhooks.verify(
 *       request,
 *       process.env.WEBHOOK_SECRET!,
 *     );
 *     // payload is the parsed JSON body
 *     return Response.json({ received: true });
 *   } catch (err) {
 *     if (err instanceof WebhookError) {
 *       return new Response(err.message, { status: 400 });
 *     }
 *     throw err;
 *   }
 * }
 */
export const standardWebhooks: StandardWebhooks = {
  verify: verifyStandardWebhooks,
  TOLERANCE_SECONDS: STANDARD_WEBHOOKS_TOLERANCE_SECONDS,
  ID_HEADER_NAME: STANDARD_WEBHOOKS_ID_HEADER_NAME,
  TIMESTAMP_HEADER_NAME: STANDARD_WEBHOOKS_TIMESTAMP_HEADER_NAME,
  SIGNATURE_HEADER_NAME: STANDARD_WEBHOOKS_SIGNATURE_HEADER_NAME,
};

async function verifyStandardWebhooks(
  request: Request,
  secret: string,
  options?: VerifyStandardWebhooksOptions
): Promise<VerifyStandardWebhooksResult> {
  const id = request.headers.get(STANDARD_WEBHOOKS_ID_HEADER_NAME);
  const timestampHeader = request.headers.get(STANDARD_WEBHOOKS_TIMESTAMP_HEADER_NAME);
  const signatureHeader = request.headers.get(STANDARD_WEBHOOKS_SIGNATURE_HEADER_NAME);

  if (!id || !timestampHeader || !signatureHeader) {
    throw new WebhookError("missing headers");
  }

  const rawBody = await request.text();

  const secretBytes = Buffer.from(secret, "base64");
  if (secretBytes.length === 0) {
    throw new WebhookError("invalid secret");
  }

  let computedBase64: string;
  try {
    const signedContent = `${id}.${timestampHeader}.${rawBody}`;
    const key = await subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const computed = await subtle.sign("HMAC", key, Buffer.from(signedContent, "utf-8"));
    computedBase64 = Buffer.from(computed).toString("base64");
  } catch (_error) {
    throw new WebhookError("Signature verification failed");
  }

  const entries = signatureHeader.split(" ");
  let matched = false;
  let hasAcceptedVersion = false;
  for (const entry of entries) {
    const dotIndex = entry.indexOf(",");
    const version = dotIndex === -1 ? entry : entry.slice(0, dotIndex);
    if (!version.startsWith(STANDARD_WEBHOOKS_SIGNATURE_VERSION)) {
      continue;
    }
    hasAcceptedVersion = true;
    const provided = dotIndex === -1 ? "" : entry.slice(dotIndex + 1);
    if (timingSafeEqual(computedBase64, provided)) {
      matched = true;
      break;
    }
  }

  if (!hasAcceptedVersion) {
    throw new WebhookError("unsupported signature version");
  }

  if (!matched) {
    throw new WebhookError("invalid signature");
  }

  const tolerance =
    options?.tolerance === undefined ? STANDARD_WEBHOOKS_TOLERANCE_SECONDS : options.tolerance;

  if (tolerance !== 0) {
    const timestampSeconds = Number(timestampHeader);
    if (!Number.isFinite(timestampSeconds)) {
      throw new WebhookError("invalid timestamp");
    }
    const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
    if (ageSeconds > tolerance) {
      throw new WebhookError("timestamp outside tolerance window");
    }
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    if (error instanceof Error) {
      throw new WebhookError(`invalid payload: ${error.message}`);
    }
    throw new WebhookError("invalid payload");
  }

  return { payload, raw: rawBody };
}

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
  } catch (_error) {
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
