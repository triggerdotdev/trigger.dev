import { isIPv4, isIPv6 } from "node:net";

/**
 * How the network that started a CLI login compares with the network of the browser approving it.
 * A real login starts and is approved on the same machine, so the two usually share a public IP.
 * `mixed-family` means one side used IPv4 and the other IPv6, which dual-stack networks do too.
 */
export type CliLoginNetworkMatch = "match" | "mismatch" | "mixed-family" | "unknown";

type Network = { family: 4 | 6; prefix: string };

/** IPv4 addresses compare whole, IPv6 addresses by their /64 prefix (one site or device). */
export function compareCliLoginNetworks(
  requesterIp: string | null | undefined,
  approverIp: string | null | undefined
): CliLoginNetworkMatch {
  const requester = networkOf(requesterIp);
  const approver = networkOf(approverIp);

  if (!requester || !approver) {
    return "unknown";
  }

  if (requester.family !== approver.family) {
    return "mixed-family";
  }

  return requester.prefix === approver.prefix ? "match" : "mismatch";
}

/** Whether the consent screen should ask the approver to confirm a login from another network. */
export function needsNetworkConfirmation(match: CliLoginNetworkMatch) {
  return match === "mismatch" || match === "mixed-family";
}

/**
 * Where a login IP is, for the consent page and the authorized-login email: "United States, on
 * Google LLC". Returns `undefined` when neither the country nor the network owner is known.
 */
export function describeIpLocation(
  location: { country: string | null; asName: string | null } | undefined
): string | undefined {
  const parts = [location?.country, location?.asName ? `on ${location.asName}` : undefined].filter(
    Boolean
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function networkOf(ip: string | null | undefined): Network | undefined {
  if (!ip) {
    return undefined;
  }

  const address = ip.trim().replace(/%.*$/, "");
  const mappedIpv4 = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];

  if (mappedIpv4 && isIPv4(mappedIpv4)) {
    return { family: 4, prefix: mappedIpv4 };
  }

  if (isIPv4(address)) {
    return { family: 4, prefix: address };
  }

  if (isIPv6(address)) {
    return { family: 6, prefix: ipv6Prefix64(address) };
  }

  return undefined;
}

function ipv6Prefix64(address: string) {
  const [head, tail] = address.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"),
          ...tailGroups,
        ];

  return groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":");
}
