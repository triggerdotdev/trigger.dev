import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";

const SUBJECT_PREFIX = "sub_v1_";
const KEY_INFO = "trigger.dev public token subject v1";
const SOURCE_PAT_PREFIX = "pat_v1_";
const SOURCE_PAT_KEY_INFO = "trigger.dev public token source PAT v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Seals an internal id for a public token claim, and opens it again. */
export type SealedIdCodec = {
  encode(id: string): string;
  decode(sealed: string): string | undefined;
};

export type PublicTokenSubjectCodec = SealedIdCodec;

export function createPublicTokenSubjectCodec(secret: string): PublicTokenSubjectCodec {
  return createSealedIdCodec(secret, KEY_INFO, SUBJECT_PREFIX);
}

/**
 * Seals the source PAT id (`act.pat`) in env JWTs and the tokens minted for them, so the raw id
 * never appears in a public token. Its own key and prefix keep it from opening as a subject.
 */
export function createSourcePersonalAccessTokenCodec(secret: string): SealedIdCodec {
  return createSealedIdCodec(secret, SOURCE_PAT_KEY_INFO, SOURCE_PAT_PREFIX);
}

function createSealedIdCodec(secret: string, keyInfo: string, prefix: string): SealedIdCodec {
  if (!secret) {
    throw new Error("A secret is required to seal public token subjects");
  }

  const keyMaterial = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), keyInfo, 64));
  const encryptionKey = keyMaterial.subarray(0, 32);
  const nonceKey = keyMaterial.subarray(32, 64);

  const nonceFor = (id: string) =>
    createHmac("sha256", nonceKey).update(id, "utf8").digest().subarray(0, NONCE_BYTES);

  return {
    encode(id) {
      const nonce = nonceFor(id);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(id, "utf8"), cipher.final()]);
      const sealed = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
      return `${prefix}${sealed.toString("base64url")}`;
    },
    decode(value) {
      if (!value.startsWith(prefix)) return;

      const sealed = Buffer.from(value.slice(prefix.length), "base64url");
      if (sealed.length <= NONCE_BYTES + TAG_BYTES) return;

      const nonce = sealed.subarray(0, NONCE_BYTES);
      const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
      const tag = sealed.subarray(sealed.length - TAG_BYTES);

      let id: string;
      try {
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
        decipher.setAuthTag(tag);
        id = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        return;
      }

      if (!timingSafeEqual(nonce, nonceFor(id))) return;

      return id;
    },
  };
}

export function isSealedPublicTokenSubject(subject: string): boolean {
  return subject.startsWith(SUBJECT_PREFIX);
}

export type ResolvedPublicTokenSubject = {
  environmentId: string;
  legacy: boolean;
};

export function resolvePublicTokenSubject(
  subject: string,
  codec: PublicTokenSubjectCodec | undefined
): ResolvedPublicTokenSubject | undefined {
  if (isSealedPublicTokenSubject(subject)) {
    const environmentId = codec?.decode(subject);
    return environmentId ? { environmentId, legacy: false } : undefined;
  }

  return { environmentId: subject, legacy: true };
}
