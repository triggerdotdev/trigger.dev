/**
 * Strip the digest suffix from a container image reference.
 * Tags are immutable, so we resolve by tag rather than pinning to a digest.
 *
 * "ghcr.io/org/image:tag@sha256:abc..." -> "ghcr.io/org/image:tag"
 * "ghcr.io/org/image@sha256:abc..."     -> "ghcr.io/org/image"
 * "ghcr.io/org/image:tag"              -> "ghcr.io/org/image:tag" (unchanged)
 */
export function stripImageDigest(imageRef: string): string {
  return imageRef.split("@")[0] ?? imageRef;
}
