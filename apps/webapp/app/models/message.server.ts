import { json, Session } from "@remix-run/node";
import { redirect } from "remix-typedjson";
import { createCookieSessionStorage } from "@remix-run/node";
import { env } from "~/env.server";

export type ToastMessage = { message: string; type: "success" | "error" };

const ONE_YEAR = 1000 * 60 * 60 * 24 * 365;

export const { commitSession, getSession } = createCookieSessionStorage({
  cookie: {
    name: "__message",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
  },
});

export function setSuccessMessage(session: Session, message: string) {
  session.flash("toastMessage", { message, type: "success" } as ToastMessage);
}

export function setErrorMessage(session: Session, message: string) {
  session.flash("toastMessage", { message, type: "error" } as ToastMessage);
}

export async function setRequestErrorMessage(
  request: Request,
  message: string
) {
  const session = await getSession(request.headers.get("cookie"));

  setErrorMessage(session, message);

  return session;
}

export async function setRequestSuccessMessage(
  request: Request,
  message: string
) {
  const session = await getSession(request.headers.get("cookie"));

  setSuccessMessage(session, message);

  return session;
}

export async function setToastMessageCookie(session: Session) {
  return {
    "Set-Cookie": await commitSession(session, {
      expires: new Date(Date.now() + ONE_YEAR),
    }),
  };
}

export async function jsonWithSuccessMessage(
  data: any,
  request: Request,
  message: string
) {
  const session = await getSession(request.headers.get("cookie"));

  setSuccessMessage(session, message);

  return json(data, {
    headers: {
      "Set-Cookie": await commitSession(session, {
        expires: new Date(Date.now() + ONE_YEAR),
      }),
    },
  });
}

export async function redirectWithSuccessMessage(
  path: string,
  request: Request,
  message: string
) {
  const session = await getSession(request.headers.get("cookie"));

  setSuccessMessage(session, message);

  return redirect(path, {
    headers: {
      "Set-Cookie": await commitSession(session, {
        expires: new Date(Date.now() + ONE_YEAR),
      }),
    },
  });
}

export async function redirectWithErrorMessage(
  path: string,
  request: Request,
  message: string
) {
  const session = await getSession(request.headers.get("cookie"));

  setErrorMessage(session, message);

  return redirect(path, {
    headers: {
      "Set-Cookie": await commitSession(session, {
        expires: new Date(Date.now() + ONE_YEAR),
      }),
    },
  });
}

export async function redirectBackWithErrorMessage(
  request: Request,
  message: string
) {
  const url = new URL(request.url);
  return redirectWithErrorMessage(url.pathname, request, message);
}

export async function redirectBackWithSuccessMessage(
  request: Request,
  message: string
) {
  const url = new URL(request.url);
  return redirectWithSuccessMessage(url.pathname, request, message);
}
