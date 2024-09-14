import { redirect } from "@remix-run/node";
import { env } from "~/env.server";
import { getUserById } from "~/models/user.server";
import { authenticator } from "./auth.server";
import { getImpersonationId } from "./impersonation.server";

export async function getUserId(request: Request): Promise<string | undefined> {
	const impersonatedUserId = await getImpersonationId(request);

	if (impersonatedUserId) return impersonatedUserId;

	let authUser = await authenticator.isAuthenticated(request);
	return authUser?.userId;
}

export async function getUser(request: Request) {
	const userId = await getUserId(request);
	if (userId === undefined) return null;

	const user = await getUserById(userId);
	if (user) return user;

	throw await logout(request);
}

export async function requireUserId(request: Request, redirectTo?: string) {
	const userId = await getUserId(request);
	if (!userId) {
		const url = new URL(request.url);
		const searchParams = new URLSearchParams([
			["redirectTo", redirectTo ?? `${url.pathname}${url.search}`],
		]);
		throw redirect(`/login?${searchParams}`);
	}
	return userId;
}

export async function requireUser(request: Request) {
	if (env.AUTH_DISABLED === "true") {
		return {
			id: "1",
			email: "admin@trigger.dev",
		};
	}

	const userId = await requireUserId(request);

	const user = await getUserById(userId);
	if (user) return user;

	throw await logout(request);
}

export async function logout(request: Request) {
	return redirect("/logout");
}
