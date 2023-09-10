// import { client } from "../../../trigger";

import type { APIRoute } from "astro";

// export const post = async () => {
//   await client.sendEvent({
//     name: "astro.event",
//     payload: { name: "John Doe", email: "john@doe.com", paidPlan: true },
//   });

//   return new Response(JSON.stringify({ message: "Queued event!" }), {
//     status: 200,
//   });
// };
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
return new Response("hello", {status: 200})

};