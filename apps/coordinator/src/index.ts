import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { env } from "./env";
import { TriggerServer } from "./server";

// Create an HTTP server
const server = createServer((req, res) => {
  res.end("Hello, World!");
});

const wss = new WebSocketServer({ noServer: true });

const triggerServers = new Map<string, TriggerServer>();

wss.on("connection", (ws, req) => {
  const apiKey = req.headers.authorization;

  if (!apiKey || typeof apiKey !== "string") {
    ws.close(1008, "Invalid API Key");
    return;
  }

  const keyPart = apiKey.split(" ")[1];

  const triggerServer = new TriggerServer(ws, keyPart);
  triggerServer.listen();

  triggerServers.set(keyPart, triggerServer);

  triggerServer.onClose.attach(() => {
    console.log(
      `Trigger server for key ${keyPart} closed. Removing it from the map.`
    );

    triggerServers.delete(keyPart);
  });
});

// Upgrade an HTTP connection to a WebSocket connection
// Only accept the upgrade if there is a valid API Key in the authorization header
server.on("upgrade", async (req, socket, head) => {
  console.log(
    `Attemping to upgrade connection at url ${
      req.url
    } with headers: ${JSON.stringify(req.headers)}`
  );

  const url = new URL(req.url ?? "", "http://localhost");

  // Only upgrade the connecting if the path is `/ws`
  if (url.pathname !== "/ws") {
    socket.destroy(
      new Error(
        "Cannot connect because of invalid path: Please include `/ws` in the path of your upgrade request."
      )
    );
    return;
  }

  console.log(`Client connected, upgrading their connection...`);

  // Handle the WebSocket connection
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// Listen on port from env
const port = env.PORT;
server.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
