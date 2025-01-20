export type DockerImageParts = {
  registry?: string;
  repo: string;
  tag?: string;
  digest?: string;
};

export function parseDockerImageReference(imageReference: string): DockerImageParts {
  const parts: DockerImageParts = { repo: "" }; // Initialize with an empty repo

  // Splitting by '@' to separate the digest (if exists)
  const atSplit = imageReference.split("@");
  if (atSplit.length > 1) {
    parts.digest = atSplit[1];
    imageReference = atSplit[0] as string;
  }

  // Splitting by ':' to separate the tag (if exists) and to ensure it's not part of a port
  let colonSplit = imageReference.split(":");
  if (
    colonSplit.length > 2 ||
    (colonSplit.length === 2 && !(colonSplit[1] as string).includes("/"))
  ) {
    // It's a tag if there's no '/' in the second part (after colon), or there are more than 2 parts (implying a port number in registry)
    parts.tag = colonSplit.pop(); // The last part is the tag
    imageReference = colonSplit.join(":"); // Join back in case it was a port number
  }

  // Check for registry
  let slashIndex = imageReference.indexOf("/");
  if (slashIndex !== -1) {
    let potentialRegistry = imageReference.substring(0, slashIndex);
    // Validate if the first part is a valid hostname-like string (registry), otherwise treat the entire string as the repo
    if (
      potentialRegistry.includes(".") ||
      potentialRegistry === "localhost" ||
      potentialRegistry.includes(":")
    ) {
      parts.registry = potentialRegistry;
      parts.repo = imageReference.substring(slashIndex + 1);
    } else {
      parts.repo = imageReference; // No valid registry found, treat as repo
    }
  } else {
    parts.repo = imageReference; // Only repo is present
  }

  return parts;
}

export function rebuildDockerImageReference(parts: DockerImageParts): string {
  let imageReference = "";

  if (parts.registry) {
    imageReference += `${parts.registry}/`;
  }

  imageReference += parts.repo; // Repo is now guaranteed to be defined

  if (parts.tag) {
    imageReference += `:${parts.tag}`;
  }

  if (parts.digest) {
    imageReference += `@${parts.digest}`;
  }

  return imageReference;
}
