import { AwsClient } from "aws4fetch";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

export const r2 = singleton("r2", initializeR2);

function initializeR2() {
  if (!env.OBJECT_STORE_ACCESS_KEY_ID || !env.OBJECT_STORE_SECRET_ACCESS_KEY) {
    return;
  }

  return new AwsClient({
    accessKeyId: env.OBJECT_STORE_ACCESS_KEY_ID,
    secretAccessKey: env.OBJECT_STORE_SECRET_ACCESS_KEY,
  });
}
