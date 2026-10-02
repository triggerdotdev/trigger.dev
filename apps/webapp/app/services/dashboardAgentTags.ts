import { createHash } from "node:crypto";

const MAX_TAG_LENGTH = 128;
const HASH_LENGTH = 8;

/** A tag over the limit keeps its prefix and swaps the tail for a hash of the whole, so two long values never share one. */
function boundedTag(tag: string): string {
  if (tag.length <= MAX_TAG_LENGTH) return tag;
  const hash = createHash("sha256").update(tag).digest("hex").slice(0, HASH_LENGTH);
  return `${tag.slice(0, MAX_TAG_LENGTH - HASH_LENGTH - 1)}~${hash}`;
}

/**
 * Tags for finding a chat's session and runs in the agent project's dashboard by who
 * started it and where. Session and run tags both get them.
 */
export function dashboardAgentTags(params: {
  organizationSlug: string;
  projectRef: string;
  environmentSlug: string;
  userId: string;
}): string[] {
  return [
    `org:${params.organizationSlug}`,
    `project:${params.projectRef}`,
    `env:${params.environmentSlug}`,
    `user:${params.userId}`,
  ].map(boundedTag);
}
