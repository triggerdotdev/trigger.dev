import type { JWTPayload } from "jose";

export type GenerateJWTOptions = {
  secretKey: string;
  payload: Record<string, any>;
  expirationTime?: number | Date | string;
};

export const JWT_ALGORITHM = "HS256";
export const JWT_ISSUER = "https://id.trigger.dev";
export const JWT_AUDIENCE = "https://api.trigger.dev";

export async function generateJWT(options: GenerateJWTOptions): Promise<string> {
  const { SignJWT } = await import("jose");

  const secret = new TextEncoder().encode(options.secretKey);

  return new SignJWT(options.payload)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(options.expirationTime ?? "15m")
    .sign(secret);
}

export type ValidationResult =
  | {
      ok: true;
      payload: JWTPayload;
    }
  | {
      ok: false;
      error: string;
      code: string;
    };

export async function validateJWT(token: string, apiKey: string): Promise<ValidationResult> {
  const { jwtVerify, errors } = await import("jose");

  const secret = new TextEncoder().encode(apiKey);

  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    return { ok: true, payload };
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      return {
        ok: false,
        error: error.message,
        code: error.code,
      };
    } else {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
        code: "ERR_UNKNOWN",
      };
    }
  }
}
