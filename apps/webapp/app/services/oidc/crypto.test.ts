import { SignJWT, decodeProtectedHeader, importPKCS8 } from "jose";
import { describe, expect, it } from "vitest";
import { OIDC_MAX_SUPPORTED_JWT_TTL_SECONDS } from "./constants";
import {
  generateRs256KeyPair,
  importRs256PrivateKey,
  signRs256Jwt,
  verifyRs256Jwt,
} from "./crypto";

const issuer = "https://oidc.example.com";
const audience = "https://service.example.com";
const now = new Date("2026-01-01T00:00:00.000Z");

describe("RS256 helpers", () => {
  it("generates a public-only JWK and signs a verifiable JWT", async () => {
    const key = await generateRs256KeyPair();

    expect(key.publicJwk).toEqual({
      kty: "RSA",
      n: expect.any(String),
      e: expect.any(String),
      kid: key.kid,
      use: "sig",
      alg: "RS256",
    });
    expect(key.publicJwk).not.toHaveProperty("d");
    expect(key.publicJwk).not.toHaveProperty("p");
    expect(key.publicJwk).not.toHaveProperty("q");

    const token = await signRs256Jwt({
      payload: { workload: "run_123" },
      privateKey: await importRs256PrivateKey(key.privateKeyPkcs8),
      kid: key.kid,
      issuer,
      audience,
      subject: "run_123",
      expiresInSeconds: 900,
      now,
    });
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "RS256", kid: key.kid });

    const verified = await verifyRs256Jwt({
      token,
      jwks: { keys: [key.publicJwk] },
      issuer,
      audience,
      now,
    });
    expect(verified.payload).toMatchObject({
      workload: "run_123",
      iss: issuer,
      aud: audience,
      sub: "run_123",
      iat: now.getTime() / 1000,
      exp: now.getTime() / 1000 + 900,
    });
  });

  it("rejects unsupported lifetimes and verification claims", async () => {
    const key = await generateRs256KeyPair();
    const input = {
      payload: {},
      privateKey: await importRs256PrivateKey(key.privateKeyPkcs8),
      kid: key.kid,
      issuer,
      audience,
      subject: "run_123",
      now,
    };

    await expect(
      signRs256Jwt({
        ...input,
        expiresInSeconds: OIDC_MAX_SUPPORTED_JWT_TTL_SECONDS + 1,
      })
    ).rejects.toThrow("JWT lifetime");

    const token = await signRs256Jwt({ ...input, expiresInSeconds: 900 });
    await expect(
      verifyRs256Jwt({
        token,
        jwks: { keys: [key.publicJwk] },
        issuer,
        audience: "https://other.example.com",
        now,
      })
    ).rejects.toThrow();
    await expect(
      verifyRs256Jwt({
        token,
        jwks: { keys: [{ ...key.publicJwk, kid: "unknown" }] },
        issuer,
        audience,
        now,
      })
    ).rejects.toThrow();

    const privateKey = await importPKCS8(key.privateKeyPkcs8, "RS256");
    const tokenWithoutExpiry = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: key.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("run_123")
      .setIssuedAt(now.getTime() / 1000)
      .sign(privateKey);
    await expect(
      verifyRs256Jwt({
        token: tokenWithoutExpiry,
        jwks: { keys: [key.publicJwk] },
        issuer,
        audience,
        now,
      })
    ).rejects.toThrow();
  });
});
