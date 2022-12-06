import { getAuth } from "@clerk/remix/ssr.server";
import { redirect } from "@remix-run/node";

export async function getUserId(request: Request): Promise<string | null> {
  const { userId } = await getAuth(request);
  return userId;
}

export async function requireUserId(request: Request): Promise<string> {
  const userId = await getUserId(request);
  console.log(userId, userId);
  if (userId == null) {
    throw redirect("/login");
  }

  return userId;
}
