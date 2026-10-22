import { z } from "zod";

export const DeliverAlertEventPayload = z.object({
  eventId: z.string(),
  eventAt: z.coerce.date(),
});
