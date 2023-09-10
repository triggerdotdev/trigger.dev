import { createAstroRoute } from "@trigger.dev/astro";

// import "../../../jobs/example"
import type { APIRoute } from "astro";

// export const {POST} = createAstroRoute(client);
export const POST: APIRoute = async ({ request }) => {
  //   if (request.headers.get("Content-Type") === "application/json") {
  //     const body = await request.json();
  //     const name = body.name;
  //     return new Response(
  //       JSON.stringify({
  //         message: "Your name was: " + name,
  //       }),
  //       {
  //         status: 200,
  //       }
  //     );
  //   }
  //   return new Response(null, { status: 400 });
  return new Response("hello", { status: 200 });
};
