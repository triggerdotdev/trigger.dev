import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("collect orphaned image files", { hours: 1 }, internal.jobs.sweepStorage, {});
export default crons;
