import { logger, task } from "@trigger.dev/sdk/v3";
import { AppDataSource, Photo } from "./orm";

export const taskThatUsesDecorators = task({
  id: "taskThatUsesDecorators",
  run: async (payload: { message: string }) => {
    console.log("Creating a photo...");

    const photo = new Photo();
    photo.id = 2;
    photo.name = "Me and Bears";
    photo.description = "I am near polar bears";
    photo.filename = "photo-with-bears.jpg";
    photo.views = 1;
    photo.isPublished = true;

    await AppDataSource.manager.save(photo);

    if (Math.random() > 0.5) {
      throw new Error("Failed to create photo");
    }
  },
  onSuccess: async (payload, output, { ctx }) => {
    logger.log("Photo created successfully", { output, ctx });
  },
  onFailure: async (payload, error, { ctx }) => {
    logger.error("Failed to create photo", { error, ctx });
  },
  onStart: async (payload, { ctx }) => {
    logger.log("Starting to create photo", { ctx });
  },
});
