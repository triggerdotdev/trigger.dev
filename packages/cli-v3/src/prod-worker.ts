import { TaskResource } from "@trigger.dev/core/v3";
import { BackgroundWorker } from "./prod/backgroundWorker";
import { createServer, IncomingMessage } from "node:http";
import { io, Socket } from "socket.io-client";

function getRandomInteger(min: number, max: number) {
  const intMin = Math.ceil(min);
  const intMax = Math.floor(max);
  return Math.floor(Math.random() * (intMax - intMin + 1)) + intMin;
}

function getRandomPortNumber() {
  return getRandomInteger(8000, 9999);
}

const DEBUG = ["v1", "true"].includes(process.env.DEBUG ?? "") || false;
const HTTP_SERVER_PORT = Number(process.env.HTTP_SERVER_PORT || getRandomPortNumber());
const DAEMON_HOST = process.env.DAEMON_HOST || "127.0.0.1";
const DAEMON_PORT = Number(process.env.DAEMON_PORT || 50080);
const MACHINE_NAME = process.env.MACHINE_NAME || "local";
const SHORT_HASH = process.env.TRIGGER_CONTENT_HASH!.slice(0, 9);

const log = (...args: any[]) => {
  console.log(`[${MACHINE_NAME}][${SHORT_HASH}]`, ...args);
};

const debug = (...args: any[]) => {
  if (!DEBUG) {
    return args[0]
  }
  log("DEBUG", ...args)
  return args[0]
}

const getBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("readable", () => {
      const chunk = req.read();
      if (chunk) {
        body += chunk;
      }
    });
    req.on("end", () => {
      resolve(body);
    });
  });

type VersionedMessage<TMessage> = { version: "v1" } & TMessage;

interface ProdWorkerToDaemonEvents {
  LOG: (message: VersionedMessage<{ text: string }>, callback: () => {}) => void;
  INDEX_TASKS: (
    message: VersionedMessage<{
      tasks: TaskResource[];
      packageVersion: string;
    }>,
    callback: (params: { success: boolean }) => {}
  ) => void;
  READY: (message: VersionedMessage<{}>) => void;
  WAIT_FOR_DURATION: (message: VersionedMessage<{ seconds: string }>) => void;
  WAIT_FOR_EVENT: (message: VersionedMessage<{ name: string }>) => void;
}

interface DaemonToProdWorkerEvents {
  INVOKE: (message: VersionedMessage<{ payload: any; context: any }>) => void;
  RESUME: (message: VersionedMessage<{}>) => void;
  RESUME_WITH: (message: VersionedMessage<{ data: any }>) => void;
}

class ProdWorker {
  private apiUrl = process.env.TRIGGER_API_URL!;
  private apiKey = process.env.TRIGGER_API_KEY!;
  private contentHash = process.env.TRIGGER_CONTENT_HASH!;
  private projectDir = process.env.TRIGGER_PROJECT_DIR!;
  private projectRef = process.env.TRIGGER_PROJECT_REF!;
  private cliPackageVersion = process.env.TRIGGER_CLI_PACKAGE_VERSION!;

  #backgroundWorker: BackgroundWorker;
  #httpServer: ReturnType<typeof createServer>;
  #daemonSocket: Socket<DaemonToProdWorkerEvents, ProdWorkerToDaemonEvents>;

  constructor(
    private port: number,
    private host = "0.0.0.0"
  ) {
    this.#backgroundWorker = new BackgroundWorker(this.#getWorkerEntryPath(this.contentHash), {
      projectDir: this.projectDir,
      env: {
        TRIGGER_API_URL: this.apiUrl,
        TRIGGER_API_KEY: this.apiKey,
      },
    });

    this.#daemonSocket = this.#createDaemonSocket();
    this.#httpServer = this.#createHttpServer();

    // TODO: create coordinator on daemon instead

    // await backgroundWorkerCoordinator.registerWorker(
    //   backgroundWorkerRecord.data,
    //   backgroundWorker
    // );
  }

  #createDaemonSocket() {
    const socket: Socket<DaemonToProdWorkerEvents, ProdWorkerToDaemonEvents> = io(
      `ws://${DAEMON_HOST}:${DAEMON_PORT}/prod-worker`,
      {
        transports: ["websocket"],
        auth: {
          apiKey: this.apiKey,
          apiUrl: this.apiUrl,
        },
        extraHeaders: {
          "x-machine-name": MACHINE_NAME,
          "x-trigger-content-hash": this.contentHash,
          "x-trigger-cli-package-version": this.cliPackageVersion,
          "x-trigger-project-ref": this.projectRef,
        },
      }
    );

    const logger = (...args: any[]) => {
      console.log(`[daemon][${socket.id ?? "NO_ID"}]`, ...args);
    };

    socket.on("connect_error", (err) => {
      logger(`connect_error: ${err.message}`);
    });

    socket.on("connect", async () => {
      logger("connect");

      if (process.env.INDEX_TASKS === "true") {
        const taskResources = await this.#initializeWorker();
        const { success } = await this.#daemonSocket.emitWithAck("INDEX_TASKS", {
          version: "v1",
          ...taskResources,
        });
        if (success) {
          logger("indexing done, shutting down..");
          process.exit(0);
        } else {
          logger("indexing failure, shutting down..");
          process.exit(1);
        }
      }
    });

    socket.on("disconnect", () => {
      logger("disconnect");
    });

    socket.on("INVOKE", async (message) => {
      logger("[INVOKE]", message);
    });

    socket.on("RESUME", async (message) => {
      logger("[RESUME]", message);
    });

    socket.on("RESUME_WITH", async (message) => {
      logger("[RESUME_WITH]", message);
    });

    return socket;
  }

  #createHttpServer() {
    const httpServer = createServer(async (req, res) => {
      log(`[${req.method}]`, req.url);

      switch (req.url) {
        case "/complete":
          setTimeout(() => process.exit(0), 1000);
          return res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");

        case "/date":
          const date = new Date();
          return res.writeHead(200, { "Content-Type": "text/plain" }).end(date.toString());

        case "/fail":
          setTimeout(() => process.exit(1), 1000);
          return res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");

        case "/health":
          return res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");

        case "/whoami":
          return res.writeHead(200, { "Content-Type": "text/plain" }).end(this.contentHash);

        case "/wait":
          this.#daemonSocket.emit("WAIT_FOR_DURATION", {
            version: "v1",
            seconds: "60",
          });
          // this is required when C/Ring established connections
          this.#daemonSocket.close();
          return res.writeHead(200, { "Content-Type": "text/plain" }).end("sent WAIT");

        case "/connect":
          this.#daemonSocket.connect();
          return res.writeHead(200).end();

        case "/close":
          this.#daemonSocket.emitWithAck("LOG", {
            version: "v1",
            text: "close without delay",
          });
          this.#daemonSocket.close();
          return res.writeHead(200).end();

        case "/close-delay":
          this.#daemonSocket.emitWithAck("LOG", {
            version: "v1",
            text: "close with delay",
          });
          setTimeout(() => {
            this.#daemonSocket.close();
          }, 200);
          return res.writeHead(200).end();

        case "/log":
          this.#daemonSocket.emitWithAck("LOG", {
            version: "v1",
            text: await getBody(req),
          });
          return res.writeHead(200).end();

        case "/preStop":
          log("should do preStop stuff, e.g. checkpoint and graceful shutdown");
          // this.#sendMessage({ action: "WAIT" })
          return res.writeHead(200, { "Content-Type": "text/plain" }).end("got preStop request");

        case "/ready":
          this.#daemonSocket.emit("READY", {
            version: "v1",
          });
          return res.writeHead(200).end();

        default:
          return res.writeHead(404).end();
      }
    });

    httpServer.on("clientError", (err, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    httpServer.on("listening", () => {
      log("http server listening on port", HTTP_SERVER_PORT);
    });

    return httpServer;
  }

  #getWorkerEntryPath(contentHash: string) {
    return `${contentHash}.mjs`;
  }

  async #initializeWorker() {
    await this.#backgroundWorker.initialize();

    let packageVersion: string | undefined;

    const taskResources: Array<TaskResource> = [];

    if (!this.#backgroundWorker.tasks) {
      throw new Error(`Background Worker started without tasks`);
    }

    for (const task of this.#backgroundWorker.tasks) {
      taskResources.push({
        id: task.id,
        filePath: task.filePath,
        exportName: task.exportName,
      });

      packageVersion = task.packageVersion;
    }

    if (!packageVersion) {
      throw new Error(`Background Worker started without package version`);
    }

    return {
      packageVersion,
      tasks: taskResources,
    };
  }

  async start() {
    this.#httpServer.listen(this.port, this.host);
  }
}

const prodWorker = new ProdWorker(HTTP_SERVER_PORT);
await prodWorker.start();
