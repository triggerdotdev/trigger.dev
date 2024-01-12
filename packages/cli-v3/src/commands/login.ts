import { z } from "zod";
import { logger } from "../utilities/logger";

const LoginOptionsSchema = z.object({
  apiUrl: z.string(),
});

export async function login(options: any) {
  console.log(options);

  const result = LoginOptionsSchema.safeParse(options);
  if (!result.success) {
    logger.error(result.error.message);
    return;
  }

  logger.info(result.data.apiUrl);
}
