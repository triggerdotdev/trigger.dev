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

function startsWith(data: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => data[offset + index] === byte);
}

/** A declared content type is a claim; the bytes have to back it. */
export function hasAvatarMagicBytes(contentType: AvatarContentType, data: Uint8Array) {
  switch (contentType) {
    case "image/png":
      return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(data, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return (
        startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)
      );
  }
}
