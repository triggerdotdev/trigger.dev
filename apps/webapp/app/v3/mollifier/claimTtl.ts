// The claim is a serialization lock that must outlive the winner's create-and-publish pipeline. A short
// customer key TTL must NOT shrink it below a pipeline floor (else the claim expires mid-pipeline and a
// polling loser re-claims → cross-DB duplicate). Floor at `minTtlSeconds` independent of key TTL; cap at max.
export function computeClaimTtlSeconds(input: {
  keyExpiresAt: Date;
  now: number;
  minTtlSeconds: number;
  maxTtlSeconds: number;
}): number {
  const keyTtlSeconds = Math.ceil((input.keyExpiresAt.getTime() - input.now) / 1000);
  return Math.min(input.maxTtlSeconds, Math.max(input.minTtlSeconds, keyTtlSeconds));
}
