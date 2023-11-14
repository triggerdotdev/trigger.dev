import path from "path";
import os from "os";
import fs from "fs";
import v8 from "v8";
import { PassThrough } from "stream";
import { json, type DataFunctionArgs } from "@remix-run/node";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { requireUser } from "~/services/session.server";

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
  const user = await requireUser(request);

  if (!user.admin) {
    throw new Response("You must be an admin to perform this action", { status: 403 });
  }

  const host = request.headers.get("X-Forwarded-Host") ?? request.headers.get("host");

  const tempDir = os.tmpdir();
  const filepath = path.join(tempDir, `${host}-${formatDate(new Date())}.heapsnapshot`);

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
