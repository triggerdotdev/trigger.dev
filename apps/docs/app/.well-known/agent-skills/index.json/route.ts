import { skillDescription, skillDigest, skillUrl } from "@/lib/agent-surface";

export const dynamic = "force-static";

export function GET() {
  return Response.json({
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "trigger",
        type: "skill-md",
        description: skillDescription,
        url: skillUrl,
        digest: skillDigest,
      },
    ],
  });
}
