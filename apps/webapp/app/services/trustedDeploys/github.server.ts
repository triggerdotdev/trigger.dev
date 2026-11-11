import { GITHUB_ACTIONS_ISSUER, TRUSTED_DEPLOY_AUDIENCE } from "@trigger.dev/core/v3";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { GithubDeployClaims } from "./policy";

const githubJwks = createRemoteJWKSet(
  new URL("https://token.actions.githubusercontent.com/.well-known/jwks")
);
const GITHUB_TOKEN_MAX_AGE = "10 minutes";
const CLOCK_TOLERANCE_SECONDS = 5;

export async function verifyGithubDeployToken(token: string, keys: JWTVerifyGetKey = githubJwks) {
  const { payload } = await jwtVerify(token, keys, {
    algorithms: ["RS256"],
    issuer: GITHUB_ACTIONS_ISSUER,
    audience: TRUSTED_DEPLOY_AUDIENCE,
    requiredClaims: ["iss", "aud", "sub", "iat", "exp", "nbf"],
    maxTokenAge: GITHUB_TOKEN_MAX_AGE,
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
  });
  return GithubDeployClaims.parse(payload);
}
