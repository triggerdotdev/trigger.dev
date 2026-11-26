/**
 * A request's user agent as people read it: `Chrome 131 · macOS`, `Node.js`, `curl 8.7.1`. It's what
 * the client says it is, matched by pattern: browsers that copy Chrome's (Brave, Arc) show as Chrome,
 * and iPads on iPadOS 13 and later say they're Macs. Anything it doesn't recognise is shown as sent.
 * Our CLI and SDK send Node's default (`node`); how they reached us is the event's source, not this.
 */
export function userAgentLabel(userAgent: string): string {
  const tool = TOOLS.find(([pattern]) => pattern.test(userAgent));
  if (tool) {
    const version = userAgent.match(tool[0])?.[1];
    return version ? `${tool[1]} ${version}` : tool[1];
  }

  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent));
  if (!browser) return userAgent;
  const major = userAgent.match(browser[0])?.[1];
  const os = OPERATING_SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return [major ? `${browser[1]} ${major}` : browser[1], os].filter(Boolean).join(" · ");
}

/** Clients that name themselves. The first match wins, so the more specific comes first. */
const TOOLS: Array<[RegExp, string]> = [
  [/^curl\/([\d.]+)/, "curl"],
  [/^node(?:\/([\d.]+))?$/, "Node.js"],
];

/**
 * Browsers by major version. Edge, Opera, Samsung Internet and Vivaldi also say Chrome, and Chrome
 * also says Safari, so they're checked first. On iOS every browser is Safari underneath and names
 * itself with its own token (CriOS, FxiOS, EdgiOS).
 */
const BROWSERS: Array<[RegExp, string]> = [
  [/EdgiOS\/(\d+)/, "Edge"],
  [/Edg\/(\d+)/, "Edge"],
  [/OPR\/(\d+)/, "Opera"],
  [/SamsungBrowser\/(\d+)/, "Samsung Internet"],
  [/Vivaldi\/(\d+)/, "Vivaldi"],
  [/FxiOS\/(\d+)/, "Firefox"],
  [/Firefox\/(\d+)/, "Firefox"],
  [/CriOS\/(\d+)/, "Chrome"],
  [/Chrome\/(\d+)/, "Chrome"],
  [/Version\/(\d+)[\d.]* .*Safari\//, "Safari"],
];

const OPERATING_SYSTEMS: Array<[RegExp, string]> = [
  [/iPhone|iPad/, "iOS"],
  [/Android/, "Android"],
  [/Windows NT/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];
