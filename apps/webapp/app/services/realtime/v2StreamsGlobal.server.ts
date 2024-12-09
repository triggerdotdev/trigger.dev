import { prisma } from "~/db.server";
import { singleton } from "~/utils/singleton";
import { realtimeClient } from "../realtimeClientGlobal.server";
import { DatabaseRealtimeStreams } from "./databaseRealtimeStreams.server";

function initializeDatabaseRealtimeStreams() {
  return new DatabaseRealtimeStreams({
    prisma,
    realtimeClient,
  });
}

export const v2RealtimeStreams = singleton("dbRealtimeStreams", initializeDatabaseRealtimeStreams);
