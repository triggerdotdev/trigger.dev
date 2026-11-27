/** The docs site's base path (next.config.mjs `basePath`). */
export const basePath = "/docs";

// Root-absolute asset paths in the MDX ("/images/x.png") live under the /docs base path.
export const withBase = <T>(src: T): T =>
  typeof src === "string" &&
  src.startsWith("/") &&
  !src.startsWith("//") &&
  !src.startsWith(`${basePath}/`)
    ? (`${basePath}${src}` as T)
    : src;
