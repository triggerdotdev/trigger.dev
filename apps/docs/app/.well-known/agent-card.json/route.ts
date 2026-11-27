import { siteDescription, skillDescription, skillUrl } from "@/lib/agent-surface";
import { docsUrl, siteUrl } from "@/lib/source";

export const dynamic = "force-static";

// A2A agent card, same fields as the one served before.
export function GET() {
  const url = `${docsUrl}/`;
  return Response.json({
    name: "Trigger.dev",
    description: siteDescription,
    url,
    version: "1.0.0",
    protocolVersion: "0.3",
    preferredTransport: "HTTP+JSON",
    supportedInterfaces: [{ url, protocolBinding: "HTTP+JSON", protocolVersion: "0.3" }],
    provider: { url, organization: "Trigger.dev" },
    documentationUrl: url,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "trigger",
        name: "trigger",
        description: skillDescription,
        tags: [],
        url: `${siteUrl}${skillUrl}`,
      },
    ],
  });
}
