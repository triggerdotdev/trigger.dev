import { isNetworkAllowHost, restrictedNetwork } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import type { PinnedRunPolicy } from "./runExecutionPolicy.server";

/** Room left for platform and secret hosts in the interceptor's 256-host binding limit. */
const MAX_BINDING_HOSTS = 256;
const S2_BASIN_PLACEHOLDER = "{basin}";

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" ? hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The HTTPS hosts every restricted run needs: this platform's API, app (default OTel), stream and
 * usage endpoints, packet object storage and realtime streams. Configured, not hardcoded, so
 * self-hosted deployments get their own. `SANDBOX_NETWORK_PLATFORM_HOSTS` adds any the URLs do not
 * cover, such as a separate OTel host. Object storage and S2 hosts are shared with other tenants.
 */
function platformNetworkHosts(): string[] {
  const s2Basin = env.REALTIME_STREAMS_S2_BASIN_URL.replace(S2_BASIN_PLACEHOLDER, "basin");
  const hosts = [
    hostOf(env.API_ORIGIN ?? env.APP_ORIGIN),
    hostOf(env.INTERNAL_API_ORIGIN),
    hostOf(env.STREAM_ORIGIN),
    hostOf(env.APP_ORIGIN),
    hostOf(env.USAGE_EVENT_URL),
    hostOf(env.OBJECT_STORE_BASE_URL),
    ...Object.entries(process.env)
      .filter(([key]) => /^OBJECT_STORE_[A-Z0-9]+_BASE_URL$/.test(key))
      .map(([, value]) => hostOf(value)),
    hostOf(env.REALTIME_STREAMS_S2_ENDPOINT),
    hostOf(env.REALTIME_STREAMS_S2_ACCOUNT_URL),
    // Basin hosts are per organization; allow the basin domain rather than track every basin.
    env.REALTIME_STREAMS_S2_BASIN_URL.includes(S2_BASIN_PLACEHOLDER)
      ? hostOf(s2Basin)?.replace(/^basin\./, "*.")
      : hostOf(env.REALTIME_STREAMS_S2_BASIN_URL),
    ...(env.SANDBOX_NETWORK_PLATFORM_HOSTS?.split(",").map((host) => host.trim()) ?? []),
  ];
  return [...new Set(hosts.filter((host): host is string => !!host && isNetworkAllowHost(host)))];
}

/**
 * The hosts a run may reach directly, or undefined when its network is unrestricted. Secret
 * (proxy-only variable) hosts are reached through the relay and need not be listed.
 */
export function runNetworkAllow(pinned: PinnedRunPolicy | undefined): string[] | undefined {
  const network = restrictedNetwork(pinned?.policy);
  if (!network) return undefined;
  const allow = [...new Set([...platformNetworkHosts(), ...network.allow])];
  if (allow.length > MAX_BINDING_HOSTS) throw new Error("Too many network hosts for this run");
  return allow;
}
