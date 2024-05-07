---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Adds support for `emitDecoratorMetadata: true` and `experimentalDecorators: true` in your tsconfig using the [`@anatine/esbuild-decorators`](https://github.com/anatine/esbuildnx/tree/main/packages/esbuild-decorators) package. This allows you to use libraries like TypeORM: 

```ts orm/index.ts
import "reflect-metadata";
import { DataSource } from "typeorm";
import { Entity, Column, PrimaryColumn } from "typeorm";

@Entity()
export class Photo {
  @PrimaryColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  description!: string;

  @Column()
  filename!: string;

  @Column()
  views!: number;

  @Column()
  isPublished!: boolean;
}

export const AppDataSource = new DataSource({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "postgres",
  database: "v3-catalog",
  entities: [Photo],
  synchronize: true,
  logging: false,
});
```

And then in your trigger.config.ts file you can initialize the datasource using the new `init` option:

```ts trigger.config.ts
import type { TriggerConfig } from "@trigger.dev/sdk/v3";
import { AppDataSource } from "@/trigger/orm";

export const config: TriggerConfig = {
  // ... other options here
  init: async (payload, { ctx }) => {
    await AppDataSource.initialize();
  },
};
```

Now you are ready to use this in your tasks:

```ts
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
```
