import Docker, {
  DockerOptions,
  ImageBuildContext,
  ImageBuildOptions,
  ImagePushOptions,
} from "dockerode";
import { z } from "zod";

const BuildAuxResultSchema = z.object({
  aux: z.object({
    ID: z.string(),
  }),
});

const BuildStreamResultSchema = z.object({
  stream: z.string(),
});

const PushAuxResultSchema = z.object({
  aux: z.object({
    Tag: z.string(),
    Digest: z.string(),
    Size: z.number(),
  }),
});

export type DockerWrapperOptions = {
  docker?: DockerOptions;
};

export class DockerWrapper {
  readonly #docker: Docker;

  constructor(options?: DockerWrapperOptions) {
    this.#docker = new Docker(options?.docker);
  }

  // https://jsonhero.io/j/PzXccoO3lCSg
  async buildImage(
    context: ImageBuildContext | string,
    options: ImageBuildOptions
  ): Promise<{ digest: string; image: string } | undefined> {
    const stream = await this.#docker.buildImage(context, options);

    const buildResults = await new Promise<any[]>((resolve, reject) => {
      this.#docker.modem.followProgress(stream, (err, res) => (err ? reject(err) : resolve(res)));
    });

    return this.#parseBuildResults(buildResults);
  }

  // https://jsonhero.io/j/BmJcRaX5rx1s
  async pushImage(
    imageName: string,
    options?: ImagePushOptions
  ): Promise<{ tag: string; digest: string; size: number } | undefined> {
    const image = this.#docker.getImage(imageName);

    const stream = await image.push(options);

    const pushResults = await new Promise((resolve, reject) => {
      this.#docker.modem.followProgress(stream, (err, res) => (err ? reject(err) : resolve(res)));
    });

    return this.#parsePushResults(pushResults);
  }

  #parsePushResults(
    pushResults: unknown
  ): { tag: string; digest: string; size: number } | undefined {
    const resultsArray = z.array(z.any()).safeParse(pushResults);

    if (!resultsArray.success) {
      return;
    }

    const auxResult = findWithSchema(PushAuxResultSchema, resultsArray.data);

    if (!auxResult) {
      return undefined;
    }

    return {
      tag: auxResult.aux.Tag,
      digest: auxResult.aux.Digest,
      size: auxResult.aux.Size,
    };
  }

  #parseBuildResults(buildResults: any[]): { digest: string; image: string } | undefined {
    const auxResult = findWithSchema(BuildAuxResultSchema, buildResults);

    if (!auxResult) {
      return undefined;
    }

    const lastResult = buildResults[buildResults.length - 1];
    const parsedLastResult = BuildStreamResultSchema.safeParse(lastResult);

    if (!parsedLastResult.success) {
      return undefined;
    }

    const image = this.#parseImageFromStream(parsedLastResult.data.stream);

    if (!image) {
      return undefined;
    }

    return {
      digest: auxResult.aux.ID,
      image,
    };
  }

  // Successfully tagged eric-webapp.trigger.dev/clm7ndmb60009dyeoe0edbf32-task-1:1.0.1
  #parseImageFromStream(stream: string): string | undefined {
    const match = stream.match(/Successfully tagged ([^:]+):([^ ]+)/);

    if (!match) {
      return undefined;
    }

    return match[1]?.trim();
  }
}

function findWithSchema<T>(schema: z.Schema<T>, items: any[]): T | undefined {
  return items.find((item) => (schema.safeParse(item).success ? true : false));
}
