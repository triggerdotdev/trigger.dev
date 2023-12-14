## Trigger.dev Yalt Server

Yalt (Yet Another Local Tunnel) is the Trigger.dev tunneling service that powers the local development of Trigger.dev cloud users.

## Why?

The Trigger.dev server communicates with user endpoints over HTTP, so during local development we need a way for the Trigger.dev server to make HTTP requests over the public internet to the user's local machine. This is accomplished via a tunneling service like ngrok, which we've been using up until now. Unfortunately, the ngrok free plan has pretty aggressive rate limits and some Trigger.dev users have faced issues with their local jobs not running/working because of this. Yalt.dev is our solution.

## How does it work?

Yalt.dev is a Cloudflare Worker that uses Durable Objects to persist a websocket connection from the `@trigger.dev/cli dev` command and proxies requests through the websocket connection and then returns responses from the websocket connection.

- There is an admin API available at `admin.trigger.dev` that allows tunnels to be created (authenticated via a SECRET_KEY)
- The Cloudflare Worker has a wildcard subdomain route `*.yalt.dev/*`
- When the client receives the tunnel ID, they can connect to the server via `wss://${tunnelId}.yalt.dev/connect`
- Now, requests to `https://${tunnelId}.yalt.dev/api/trigger` are sent to the Durable Object (`YaltConnection`) using the subdomain/tunnelId
- Requests are serialized to a JSON string and sent to the WebSocket
- The WebSocket client running in `@trigger.dev/cli dev` receives the request message and makes a real request to the local dev server
- The `@trigger.dev/cli dev` serializes the response and sends it back to the server.
- The server responds to the original request

Along with this server there is a package called `@trigger.dev/yalt` that has shared code and is used in:

- Yalt.dev server (this project)
- `@trigger.dev/cli dev` command
- The Trigger.dev server (to create the tunnels)
