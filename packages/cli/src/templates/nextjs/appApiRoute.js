import { createAppRoute } from "@trigger.dev/nextjs";
import { client } from "${routePathPrefix}trigger";

import "${routePathPrefix}jobs";

//this route is used to send and receive data with Trigger.dev
export const { POST, dynamic } = createAppRoute(client);

//uncomment this to set a higher max duration (it must be inside your plan limits). Full docs: https://vercel.com/docs/functions/serverless-functions/runtimes#max-duration
//export const maxDuration = 60;