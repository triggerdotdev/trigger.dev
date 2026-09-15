export function rewriteImageRegistry(
  imageRef: string,
  from: string | undefined,
  to: string | undefined
): string {
  if (!from || !to) {
    return imageRef;
  }

  if (!imageRef.startsWith(`${from}/`)) {
    return imageRef;
  }

  return `${to}${imageRef.slice(from.length)}`;
}
