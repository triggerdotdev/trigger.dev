export async function randomUUID(): Promise<string> {
  const { randomUUID } = await import("uncrypto");

  return randomUUID();
}

export async function digestSHA256(data: string): Promise<string> {
  const { subtle } = await import("uncrypto");

  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(data));

  // Return a hex string, using cross-runtime compatible methods
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
