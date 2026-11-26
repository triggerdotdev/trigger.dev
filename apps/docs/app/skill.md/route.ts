import { skill } from "@/lib/agent-surface";

export const dynamic = "force-static";

export function GET() {
  return new Response(skill, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
}
