import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";

const SUBJECT_PREFIX = "sub_v1_";
const KEY_INFO = "trigger.dev public token subject v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type PublicTokenSubjectCodec = {
  encode(environmentId: string): string;
  decode(subject: string): string | undefined;
};

export function createPublicTokenSubjectCodec(secret: string): PublicTokenSubjectCodec {
  if (!secret) {
    throw new Error("A secret is required to seal public token subjects");
  }

  const keyMaterial = Buffer.from(hkdfSync("sha256", secret, Buffer.alloc(0), KEY_INFO, 64));
  const encryptionKey = keyMaterial.subarray(0, 32);
  const nonceKey = keyMaterial.subarray(32, 64);

  const nonceFor = (environmentId: string) =>
    createHmac("sha256", nonceKey).update(environmentId, "utf8").digest().subarray(0, NONCE_BYTES);

  return {
    encode(environmentId) {
      const nonce = nonceFor(environmentId);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(environmentId, "utf8"), cipher.final()]);
      const sealed = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
      return `${SUBJECT_PREFIX}${sealed.toString("base64url")}`;
    },
    decode(subject) {
      if (!subject.startsWith(SUBJECT_PREFIX)) return;

      const sealed = Buffer.from(subject.slice(SUBJECT_PREFIX.length), "base64url");
      if (sealed.length <= NONCE_BYTES + TAG_BYTES) return;

      const nonce = sealed.subarray(0, NONCE_BYTES);
      const ciphertext = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
      const tag = sealed.subarray(sealed.length - TAG_BYTES);

      let environmentId: string;
      try {
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, nonce);
        decipher.setAuthTag(tag);
        environmentId = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
          "utf8"
        );
      } catch {
        return;
      }

      if (!timingSafeEqual(nonce, nonceFor(environmentId))) return;

      return environmentId;
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
