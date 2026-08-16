import { type ProviderRegistryEntry } from "./types.js";

/**
 * Auth0 log streams authenticate with a static bearer token compared against the Authorization
 * header, not an HMAC/Ed25519 signature, so no preset applies. Deliveries are a JSON array of log
 * events (JSON Lines is also selectable, but array is the default Content Format); each element wraps
 * the log event under `data`, so the event kind lives at `data.type` (e.g. "s" success login, "ss"
 * success signup, "fp"/"fu" failed login variants).
 */
export const entry: ProviderRegistryEntry = {
  id: "auth0",
  label: "Auth0",
  category: "auth-identity",
  docsUrl: "https://auth0.com/docs/customize/log-streams/custom-log-streams",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "0.data.type" },
  sampleSource: "handauthored",
};
