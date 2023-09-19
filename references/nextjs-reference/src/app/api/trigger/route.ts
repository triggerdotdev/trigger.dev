import { createAppRoute } from "@trigger.dev/nextjs";
import { client } from "@/trigger";

import "@/jobs/hooks";
// import "@/jobs/events";
// import "@/jobs/general";
// import "@/jobs/github";
// import "@/jobs/logging";
// import "@/jobs/openai";
// import "@/jobs/plain";
// import "@/jobs/schedules";
// import "@/jobs/slack";
// import "@/jobs/typeform";
// import "@/jobs/edgeCases";
// import "@/jobs/supabase";
// import "@/jobs/stripe";

export const { POST, dynamic } = createAppRoute(client);
