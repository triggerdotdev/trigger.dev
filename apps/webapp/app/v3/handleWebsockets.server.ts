import { singleton } from "../utils/singleton";
import { WebSocketServer } from "ws";

export const wss = singleton("wss", initalizeWebSocketServer);

function initalizeWebSocketServer() {
  const server = new WebSocketServer({ noServer: true });

  server.on("connection", (ws, req) => {
    const apiKey = req.headers.authorization;

    if (!apiKey || typeof apiKey !== "string") {
      console.log("Invalid API Key, closing the connection");

      ws.close(1008, "Invalid API Key");
      return;
    }

    console.log(`[${process.pid}] Client connected with API Key: ${apiKey}`);
  });

  return server;
}
