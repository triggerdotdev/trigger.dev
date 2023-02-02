import { z } from "zod";

export const sharedContactSchema = z.object({
  name: z
    .object({
      formatted_name: z.string(),
      first_name: z.string().optional(),
      middle_name: z.string().optional(),
      last_name: z.string().optional(),
      suffix: z.string().optional(),
      prefix: z.string().optional(),
    })
    .optional(),
  emails: z
    .array(z.object({ type: z.string().optional(), email: z.string() }))
    .optional(),
  phones: z
    .array(
      z.object({
        type: z.string().optional(),
        phone: z.string(),
        wa_id: z.string().optional(),
      })
    )
    .optional(),
  birthday: z.string().optional(),
  addresses: z
    .array(
      z.object({
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        zip: z.string().optional(),
        country: z.string().optional(),
        country_code: z.string().optional(),
        type: z.string().optional(),
      })
    )
    .optional(),
  org: z
    .object({
      company: z.string().optional(),
      department: z.string().optional(),
      title: z.string().optional(),
    })
    .optional(),
  urls: z
    .array(
      z.object({
        url: z.string().optional(),
        type: z.string().optional(),
      })
    )
    .optional(),
});
