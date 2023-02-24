import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";

export async function loader() {
  const templates = await prisma.template.findMany({
    orderBy: { priority: "asc" },
  });

  return json(templates);
}
