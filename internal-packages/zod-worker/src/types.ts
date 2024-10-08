import { z } from "zod";

export const notificationCatalog = {
  "trigger:graphile:migrate": z.object({
    latestMigration: z.number(),
  }),
};

export type NotificationCatalog = typeof notificationCatalog;

export type NotificationChannel = keyof NotificationCatalog;
