import { task } from "@trigger.dev/sdk/v3";
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
  },
});
