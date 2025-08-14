import { type DataFunctionArgs } from "@remix-run/node";
import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import v8 from "v8";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

// Format date as yyyy-MM-dd HH_mm_ss_SSS
function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const milliseconds = date.getMilliseconds();

  return `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")} ${hours
    .toString()
    .padStart(2, "0")}_${minutes.toString().padStart(2, "0")}_${seconds
    .toString()
    .padStart(2, "0")}_${milliseconds.toString().padStart(3, "0")}`;
}

export async function loader({ request }: DataFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    throw new Response("You must be an admin to perform this action", { status: 403 });
  }

  const user = await prisma.user.findFirst({
    where: {
      id: authenticationResult.userId,
    },
  });

  if (!user?.admin) {
    throw new Response("You must be an admin to perform this action", { status: 403 });
  }

  const tempDir = os.tmpdir();
  const filepath = path.join(
    tempDir,
    `${getTaskIdentifier()}-${formatDate(new Date())}.heapsnapshot`
  );

  const snapshotPath = v8.writeHeapSnapshot(filepath);
  if (!snapshotPath) {
    throw new Response("No snapshot saved", { status: 500 });
  }

  const body = new PassThrough();
  const stream = fs.createReadStream(snapshotPath);
  stream.on("open", () => stream.pipe(body));
  stream.on("error", (err) => body.end(err));
  stream.on("end", () => body.end());

  return new Response(body as any, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(snapshotPath)}"`,
      "Content-Length": (await fs.promises.stat(snapshotPath)).size.toString(),
    },
  });
}

function getTaskIdentifier() {
  if (!process.env.ECS_CONTAINER_METADATA_URI) {
    return "local";
  }

  const url = new URL(process.env.ECS_CONTAINER_METADATA_URI);

  return url.pathname.split("/")[2].split("-")[0];
}
