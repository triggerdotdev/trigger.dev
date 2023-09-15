import { Response } from "@remix-run/node";
import { LoaderArgs, json } from "@remix-run/server-runtime";
import {
  BackgroundFunction,
  BackgroundFunctionArtifact,
  PrismaClient,
} from "@trigger.dev/database";
import archiver from "archiver";
import { z } from "zod";
import { prisma } from "~/db.server";

const ParamsSchema = z.object({
  id: z.string(),
});

export async function loader({ params }: LoaderArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid request params" }, { status: 400 });
  }

  const service = new GenerateBackgroundFunctionArtifactArchiveService();

  const results = await service.call(parsedParams.data.id);

  if (!results) {
    return json({ error: "Something went wrong" }, { status: 500 });
  }

  return new Response(results.archive, {
    headers: {
      "Content-Disposition": `attachment; filename="${results.name}"`,
      "Content-Type": "application/gzip",
    },
  });
}

class GenerateBackgroundFunctionArtifactArchiveService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const artifact = await this.#prismaClient.backgroundFunctionArtifact.findUnique({
      where: {
        id,
      },
      include: {
        backgroundFunction: true,
      },
    });

    if (!artifact) {
      return;
    }

    const archive = archiver("tar", {
      gzip: true,
      zlib: { level: 9 }, // Sets the compression level
    });

    function addFileToContext(contents: string, path: string) {
      // Append files to the archive
      archive.append(contents, { name: `ctx/${path}` });
    }

    // Good practice to catch warnings (ie stat failures and other non-blocking errors)
    archive.on("warning", function (err) {
      if (err.code === "ENOENT") {
        // log warning
        console.warn(err);
      } else {
        // throw error
        throw err;
      }
    });

    // Good practice to catch this error explicitly
    archive.on("error", function (err) {
      throw err;
    });

    addFileToContext(artifact.bundle, `src/${artifact.fileName}`);
    addFileToContext(
      JSON.stringify(this.#generatePackageJson(artifact, artifact.backgroundFunction)),
      "package.json"
    );
    addFileToContext(this.#generateDockerfile(artifact, artifact.backgroundFunction), "Dockerfile");
    addFileToContext(this.#generateIndexJs(artifact, artifact.backgroundFunction), "src/index.js");

    // Finalize the archive
    archive.finalize();

    return {
      archive,
      name: `${artifact.id}.tar.gz`,
    };
  }

  #generatePackageJson(artifact: BackgroundFunctionArtifact, task: BackgroundFunction) {
    return {
      name: task.slug,
      version: artifact.version,
      description: `Trigger background function ${task.slug}`,
      main: "src/index.js",
      scripts: {
        start: "node src/index.js",
      },
      dependencies: artifact.dependencies,
      engines: {
        node: this.#getNodeVersion(artifact.nodeVersion),
      },
    };
  }

  #generateDockerfile(artifact: BackgroundFunctionArtifact, func: BackgroundFunction) {
    return `FROM node:${this.#getNodeVersion(artifact.nodeVersion)}-bullseye-slim
    
    WORKDIR /usr/src/app
    
    COPY ctx/package*.json ./
    
    RUN npm install
    
    COPY ctx/. .
    
    CMD [ "npm", "start" ]
    `;
  }

  #generateIndexJs(artifact: BackgroundFunctionArtifact, func: BackgroundFunction) {
    return `
      const func = require("./${artifact.fileName}").default; 
      console.log(JSON.stringify(func.toJSON()));
      console.log(process.env);
    `;
  }

  // replace the v if it exists
  #getNodeVersion(version: string) {
    return version.replace("v", "");
  }
}
