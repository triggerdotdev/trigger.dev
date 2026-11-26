import { env } from "~/env.server";
import { cliVersionPolicyFor, parseCliVersionPolicy } from "./cliVersionPolicy.server";

const globalPolicy = parseCliVersionPolicy({
  minimum: env.DEPLOY_MIN_CLI_VERSION,
  enforcedFrom: env.DEPLOY_MIN_CLI_VERSION_ENFORCED_FROM,
});

export function deployCliVersionPolicy(org: { featureFlags: unknown }) {
  return cliVersionPolicyFor(org, globalPolicy);
}
