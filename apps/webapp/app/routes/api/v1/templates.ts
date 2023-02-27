import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";

export async function loader() {
  const templates = await prisma.template.findMany({
    orderBy: { priority: "asc" },
    where: { isLive: true },
  });

  return json(templates);
}
