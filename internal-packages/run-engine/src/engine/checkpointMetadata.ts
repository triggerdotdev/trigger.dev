type CheckpointRow = {
  id: string;
  type: "DOCKER" | "KUBERNETES" | "COMPUTE";
  location: string;
  imageRef: string | null;
  reason: string | null;
  metadata: string | null;
};

/** This codec is the column's only writer, so its one shape is matched exactly on read. */
const DIGEST_METADATA = /^\{"digest":"(sha256:[a-f0-9]{64})"\}$/;

/** The digest travels in the checkpoint's metadata column, as `{"digest":"sha256:..."}`. */
export function encodeCheckpointMetadata(digest: string | null | undefined): string | null {
  return digest ? JSON.stringify({ digest }) : null;
}

export function checkpointDigestFromMetadata(metadata: string | null): string | undefined {
  return metadata ? DIGEST_METADATA.exec(metadata)?.[1] : undefined;
}

/** The checkpoint a dequeued message carries, with the digest lifted out of its metadata. */
export function dequeueCheckpointFromRow<T extends CheckpointRow>(
  checkpoint: T | null | undefined
) {
  if (!checkpoint) {
    return undefined;
  }

  const { metadata, ...rest } = checkpoint;
  return { ...rest, digest: checkpointDigestFromMetadata(metadata) };
}
