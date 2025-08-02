import { registerOTel } from "@vercel/otel";

export function register() {
  registerOTel({ serviceName: "d3-chat" });
}
