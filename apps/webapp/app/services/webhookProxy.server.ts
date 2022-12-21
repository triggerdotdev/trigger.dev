import ngrok from "ngrok";
import { env } from "~/env.server";

let originOrProxyUrl: string;

declare global {
  var __origin_or_proxy_url__: string;
}

export async function init() {
  if (originOrProxyUrl) {
    return;
  }

  if (env.NODE_ENV === "production" || !env.NGROK_AUTH_TOKEN) {
    originOrProxyUrl = env.APP_ORIGIN;
  } else {
    if (!global.__origin_or_proxy_url__) {
      const proxyUrl = await ngrok.connect({
        addr: process.env.REMIX_APP_PORT || 3000,
        authtoken: env.NGROK_AUTH_TOKEN,
        subdomain: env.NGROK_SUBDOMAIN,
      });

      console.log(`🚧 Initiated Proxy URL: ${proxyUrl} 🚧`);

      global.__origin_or_proxy_url__ = proxyUrl;
    }
    originOrProxyUrl = global.__origin_or_proxy_url__;
  }
}

export { originOrProxyUrl };
