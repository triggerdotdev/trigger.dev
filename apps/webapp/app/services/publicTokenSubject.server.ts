import { createPublicTokenSubjectCodec, type PublicTokenSubjectCodec } from "@trigger.dev/rbac";
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

export function publicTokenSubject(environmentId: string): string {
  return env.PUBLIC_TOKEN_SEALED_SUBJECT_ENABLED
    ? publicTokenSubjects.encode(environmentId)
    : environmentId;
}
