/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export interface Env {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response(`Hello World! ${request.url}`);

    const url = new URL(request.url);

    if (url.pathname === "/api/v1/events" && request.method === "POST") {
      return new Response("Hello worker!");
    }

    return fetch(request);
  },
};
