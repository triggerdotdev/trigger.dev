import { resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";

export function withLegacyEncryptionKeyring<T extends { ENCRYPTION_KEY: string }>(env: T) {
  // CLI tests mutate their fixture after import, so preserve the object identity.
  return Object.assign(env, {
    ENCRYPTION_KEYRING: resolveEncryptionKeyring(undefined, env.ENCRYPTION_KEY),
  });
}
