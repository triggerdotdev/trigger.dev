import { json } from "@remix-run/server-runtime";
import { validateJWT } from "@trigger.dev/core/v3/jwt";
import { findEnvironmentById } from "~/models/runtimeEnvironment.server";

export async function validatePublicJwtKey(token: string) {
  // Get the sub claim from the token
  // Use the sub claim to find the environment
  // Validate the token against the environment.apiKey
  // Once that's done, return the environment and the claims
  const sub = extractJWTSub(token);

  if (!sub) {
    throw json({ error: "Invalid Public Access Token, missing subject." }, { status: 401 });
  }

  const environment = await findEnvironmentById(sub);

  if (!environment) {
    throw json({ error: "Invalid Public Access Token, environment not found." }, { status: 401 });
  }

  const result = await validateJWT(token, environment.apiKey);

  if (!result.ok) {
    switch (result.code) {
      case "ERR_JWT_EXPIRED": {
        throw json(
          {
            error:
              "Public Access Token has expired. See https://trigger.dev/docs/frontend/overview#authentication for more information.",
          },
          { status: 401 }
        );
      }
      case "ERR_JWT_CLAIM_INVALID": {
        throw json(
          {
            error: `Public Access Token is invalid: ${result.error}. See https://trigger.dev/docs/frontend/overview#authentication for more information.`,
          },
          { status: 401 }
        );
      }
      default: {
        throw json(
          {
            error:
              "Public Access Token is invalid. See https://trigger.dev/docs/frontend/overview#authentication for more information.",
          },
          { status: 401 }
        );
      }
    }
  }

  return {
    environment,
    claims: result.payload,
  };
}

export function isPublicJWT(token: string): boolean {
  // Split the token
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  try {
    // Decode the payload (second part)
    const payload = JSON.parse(decodeBase64Url(parts[1]));

    if (payload === null || typeof payload !== "object") return false;

    // Check for the pub: true claim
    return "pub" in payload && payload.pub === true;
  } catch (error) {
    // If there's any error in decoding or parsing, it's not a valid JWT
    return false;
  }
}

function extractJWTSub(token: string): string | undefined {
  // Split the token
  const parts = token.split(".");
  if (parts.length !== 3) return;

  try {
    // Decode the payload (second part)
    const payload = JSON.parse(decodeBase64Url(parts[1]));

    if (payload === null || typeof payload !== "object") return;

    // Check for the pub: true claim
    return "sub" in payload && typeof payload.sub === "string" ? payload.sub : undefined;
  } catch (error) {
    // If there's any error in decoding or parsing, it's not a valid JWT
    return;
  }
}

function decodeBase64Url(str: string): string {
  // Replace URL-safe characters and add padding
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  switch (str.length % 4) {
    case 2:
      str += "==";
      break;
    case 3:
      str += "=";
      break;
  }

  // Decode using Node.js Buffer
  return Buffer.from(str, "base64").toString("utf8");
}
