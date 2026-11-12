import {
  createPublicTokenSubjectCodec,
  createSourcePersonalAccessTokenCodec,
  type PublicTokenSubjectCodec,
  type SealedIdCodec,
} from "@trigger.dev/rbac";
import { env } from "~/env.server";

let codec: PublicTokenSubjectCodec | undefined;

function getCodec(): PublicTokenSubjectCodec {
  codec ??= createPublicTokenSubjectCodec(env.PUBLIC_TOKEN_SUBJECT_SECRET ?? env.ENCRYPTION_KEY);
  return codec;
}

export const publicTokenSubjects: PublicTokenSubjectCodec = {
  encode: (environmentId) => getCodec().encode(environmentId),
  decode: (subject) => getCodec().decode(subject),
};

let sourcePersonalAccessTokenCodec: SealedIdCodec | undefined;

function getSourcePersonalAccessTokenCodec(): SealedIdCodec {
  sourcePersonalAccessTokenCodec ??= createSourcePersonalAccessTokenCodec(
    env.PUBLIC_TOKEN_SUBJECT_SECRET ?? env.ENCRYPTION_KEY
  );
  return sourcePersonalAccessTokenCodec;
}

/** Seals and opens the source PAT id (`act.pat`) in public tokens. */
export const sourcePersonalAccessTokens: SealedIdCodec = {
  encode: (tokenId) => getSourcePersonalAccessTokenCodec().encode(tokenId),
  decode: (sealed) => getSourcePersonalAccessTokenCodec().decode(sealed),
};

export function publicTokenSubject(environmentId: string): string {
  return env.PUBLIC_TOKEN_SEALED_SUBJECT_ENABLED
    ? publicTokenSubjects.encode(environmentId)
    : environmentId;
}
