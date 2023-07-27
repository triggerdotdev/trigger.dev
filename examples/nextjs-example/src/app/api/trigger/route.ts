import { createAppRoute } from "@trigger.dev/nextjs";
import { client } from "@/trigger";

import "@/jobs/events";
import "@/jobs/general";
import "@/jobs/github";
import "@/jobs/logging";
import "@/jobs/openai";
import "@/jobs/plain";
import "@/jobs/resend";
import "@/jobs/schedules";
import "@/jobs/slack";
import "@/jobs/typeform";
import "@/jobs/edgeCases";
import "@/jobs/hooks";
import "@/jobs/supabase";

export const { POST, dynamic } = createAppRoute(client);
