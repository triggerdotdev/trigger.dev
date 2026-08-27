export const MAX_AVATAR_SIZE_IN_BYTES = 5 * 1024 * 1024;

export const AVATAR_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

export type AvatarContentType = keyof typeof AVATAR_EXTENSIONS;

export function isAvatarContentType(contentType: string): contentType is AvatarContentType {
  return contentType in AVATAR_EXTENSIONS;
}
