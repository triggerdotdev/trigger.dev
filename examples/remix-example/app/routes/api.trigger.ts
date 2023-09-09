import { createRemixRoute } from "@trigger.dev/remix";

import { client } from "~/trigger";

import "~/jobs/example";

//this route is used to send and receive data with Trigger.dev
export const {action} = createRemixRoute(client);

// export async function action({ request }: ActionArgs) {
//   console.log("this is the env", process.env.TRIGGER_API_KEY);
//   console.log("this is the request headers: ", request.headers);
//   // const standardRequest = await convertToStandardRequest(request);
//   // console.log("this is the standard request", standardRequest)
//   const response = await client.handleRequest(request);

//   if (!response) {
//     return json({ error: "Not found" }, { status: 404 });
//   }

//   console.log("this is test", response.body);

//   return json(response.body, { status: response.status });
// }
