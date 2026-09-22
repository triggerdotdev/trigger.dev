import { type ProviderRegistryEntry } from "./types.js";

/**
 * GitLab authenticates webhooks with a shared secret token sent verbatim in `X-Gitlab-Token`, not a
 * signature, so no verifier preset applies; `webhooks.gitlab()` in the SDK carries the shared-secret
 * config. Samples ship sample-only.
 */
export const entry: ProviderRegistryEntry = {
  id: "gitlab",
  label: "GitLab",
  category: "source-control",
  docsUrl: "https://docs.gitlab.com/user/project/integrations/webhooks/",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "header", name: "x-gitlab-event" },
  sampleSource: "hookdeck",
};
