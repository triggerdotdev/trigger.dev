import { createHash } from "node:crypto";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import {
  AVATAR_EXTENSIONS,
  type AvatarContentType,
  hasAvatarMagicBytes,
  isAvatarContentType,
  MAX_AVATAR_SIZE_IN_BYTES,
} from "~/utils/avatarLimits";
import { imageOriginFromUrl } from "~/utils/cspImageOrigins";
import { getObjectStoreClient } from "~/v3/objectStore.server";

/** Avatars always live in plain S3, never the default/R2 protocol. */
const AVATAR_STORE_PROTOCOL = "s3";
const AVATAR_PRESIGN_EXPIRY_IN_SECONDS = 300;

const AVATAR_FILENAME_REGEX = /^[0-9a-f]{32}\.(png|jpg|webp)$/;
const USER_ID_REGEX = /^[A-Za-z0-9_-]+$/;

/** Undefined when no avatar store is configured, so the policy stays unchanged. */
export function avatarObjectStoreImageOrigin() {
  return imageOriginFromUrl(env.OBJECT_STORE_S3_BASE_URL);
}

/** The first segment of a logical key is the bucket, as with `packets/…`. */
function requireAvatarObjectStore() {
  const client = getObjectStoreClient(AVATAR_STORE_PROTOCOL);

  if (!client) {
    throw new Error(`Object store is not configured for protocol: ${AVATAR_STORE_PROTOCOL}`);
  }

  if (!client.bucket) {
    throw new Error("OBJECT_STORE_S3_BUCKET is required to store avatars");
  }

  return { client, objectKey: (path: string) => `${client.bucket}/${path}` };
}

export function buildUserAvatarUrl(userId: string, filename: string) {
  return `/resources/account/avatar/${userId}/${filename}`;
}

export function buildUserAvatarFilename(contentType: AvatarContentType, data: Uint8Array) {
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 32);
  return `${hash}.${AVATAR_EXTENSIONS[contentType]}`;
}

/** Undefined when the params can't name an avatar object, so callers 404 instead of signing. */
export function resolveUserAvatarObjectPath(userId: string, filename: string): string | undefined {
  if (!USER_ID_REGEX.test(userId) || !AVATAR_FILENAME_REGEX.test(filename)) {
    return undefined;
  }

  return `avatars/${userId}/${filename}`;
}

export type AvatarUpload = { contentType: AvatarContentType; data: Uint8Array };
export type AvatarUploadRejection = { error: string; status: 400 | 413 | 415 };

/**
 * Nothing here can name the key's user: the id comes from the session, never from the body.
 */
export async function parseAvatarUpload(
  formData: FormData
): Promise<AvatarUpload | AvatarUploadRejection> {
  const image = formData.get("image");

  if (!(image instanceof File)) {
    return { error: "Missing image", status: 400 };
  }

  if (!isAvatarContentType(image.type)) {
    return { error: "Unsupported image type", status: 415 };
  }

  if (image.size > MAX_AVATAR_SIZE_IN_BYTES) {
    return { error: "Image is too large", status: 413 };
  }

  const data = new Uint8Array(await image.arrayBuffer());

  if (!hasAvatarMagicBytes(image.type, data)) {
    return { error: "Unsupported image type", status: 415 };
  }

  return { contentType: image.type, data };
}

export function absoluteUserAvatarUrl(avatarUrl: string | null) {
  if (!avatarUrl || !avatarUrl.startsWith("/")) {
    return avatarUrl;
  }

  return `${env.APP_ORIGIN}${avatarUrl}`;
}

export function isAvatarUploadRejection(
  upload: AvatarUpload | AvatarUploadRejection
): upload is AvatarUploadRejection {
  return "error" in upload;
}

export async function uploadUserAvatar({
  userId,
  contentType,
  data,
}: {
  userId: string;
  contentType: AvatarContentType;
  data: Uint8Array;
}) {
  const filename = buildUserAvatarFilename(contentType, data);
  const path = resolveUserAvatarObjectPath(userId, filename);

  if (!path) {
    throw new Error("Invalid avatar object path");
  }

  const { client, objectKey } = requireAvatarObjectStore();
  await client.putObject(objectKey(path), data, contentType);

  return { filename, avatarUrl: buildUserAvatarUrl(userId, filename) };
}

const AVATAR_URL_REGEX = /^\/resources\/account\/avatar\/([^/]+)\/([^/]+)$/;

/**
 * Undefined unless the stored URL is this user's own avatar route and names a different object:
 * an OAuth avatar elsewhere is not ours to delete, and the same content hash is the same file.
 * Without a replacement filename the object is always stale — the avatar is being removed.
 */
export function resolveStaleAvatarObjectPath({
  previousAvatarUrl,
  userId,
  filename,
}: {
  previousAvatarUrl: string | null;
  userId: string;
  filename?: string;
}): string | undefined {
  const match = previousAvatarUrl?.match(AVATAR_URL_REGEX);

  if (!match) {
    return undefined;
  }

  const [, previousUserId, previousFilename] = match;

  if (previousUserId !== userId || previousFilename === filename) {
    return undefined;
  }

  return resolveUserAvatarObjectPath(previousUserId, previousFilename);
}

export async function deleteStaleUserAvatar(options: {
  previousAvatarUrl: string | null;
  userId: string;
  filename?: string;
}) {
  const path = resolveStaleAvatarObjectPath(options);

  if (!path) {
    return;
  }

  try {
    const { client, objectKey } = requireAvatarObjectStore();
    await client.deleteObject(objectKey(path));
  } catch (error) {
    logger.warn("Failed to delete the previous avatar", {
      userId: options.userId,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function readUserAvatarBytes(objectPath: string) {
  const { client, objectKey } = requireAvatarObjectStore();

  return client.getObjectBytes(objectKey(objectPath));
}

export function presignUserAvatarUrl(objectPath: string) {
  const { client, objectKey } = requireAvatarObjectStore();

  return client.presign(objectKey(objectPath), "GET", AVATAR_PRESIGN_EXPIRY_IN_SECONDS);
}
