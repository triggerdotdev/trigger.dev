import { z } from "zod";

export const MAX_EMAIL_LENGTH = 254;

export const emailSchema = z
  .string()
  .email()
  .max(MAX_EMAIL_LENGTH, `Email must be ${MAX_EMAIL_LENGTH} characters or fewer`);
