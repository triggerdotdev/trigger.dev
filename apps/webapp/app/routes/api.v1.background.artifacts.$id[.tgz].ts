import { Response } from "@remix-run/node";
import { LoaderArgs, json } from "@remix-run/server-runtime";
import { BackgroundTask, BackgroundTaskArtifact, PrismaClient } from "@trigger.dev/database";
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

  const service = new GenerateBackgroundTaskArtifactArchiveService();

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

class GenerateBackgroundTaskArtifactArchiveService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const artifact = await this.#prismaClient.backgroundTaskArtifact.findUnique({
      where: {
        id,
      },
      include: {
        backgroundTask: true,
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
      JSON.stringify(this.#generatePackageJson(artifact, artifact.backgroundTask)),
      "package.json"
    );
    addFileToContext(this.#generateDockerfile(artifact, artifact.backgroundTask), "Dockerfile");
    addFileToContext(this.#generateIndexJs(artifact, artifact.backgroundTask), "src/index.js");

    // Finalize the archive
    archive.finalize();

    return {
      archive,
      name: `${artifact.id}.tar.gz`,
    };
  }

  #generatePackageJson(artifact: BackgroundTaskArtifact, task: BackgroundTask) {
    return {
      name: task.slug,
      version: artifact.version,
      description: `Trigger background task ${task.slug}`,
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

  #generateDockerfile(artifact: BackgroundTaskArtifact, task: BackgroundTask) {
    return `FROM amd64/node:${this.#getNodeVersion(artifact.nodeVersion)}-bullseye-slim
    
    WORKDIR /usr/src/app
    
    COPY ctx/package*.json ./
    
    RUN npm install
    
    COPY ctx/. .
    
    CMD [ "npm", "start" ]
    `;
  }

  #generateIndexJs(artifact: BackgroundTaskArtifact, task: BackgroundTask) {
    return `
      const task = require("./${artifact.fileName}").default; 
      console.log(task);
      console.log(process.env);
    `;
  }

  // replace the v if it exists
  #getNodeVersion(version: string) {
    return version.replace("v", "");
  }
}
