import { json, createCookieSessionStorage, type Session } from "@remix-run/node";
import { redirect, typedjson } from "remix-typedjson";
import { ButtonVariant } from "~/components/primitives/Buttons";
import { env } from "~/env.server";
import { type FeedbackType } from "~/routes/resources.feedback";

export type ToastMessage = {
  message: string;
  type: "success" | "error";
  options: Required<ToastMessageOptions>;
};

export type ToastMessageAction = {
  label: string;
  variant?: ButtonVariant;
  action:
    | {
        type: "link";
        path: string;
      }
    | {
        type: "help";
        feedbackType: FeedbackType;
      };
};

export type ToastMessageOptions = {
  title?: string;
  /** Ephemeral means it disappears after a delay, defaults to true */
  ephemeral?: boolean;
  /** This display a button and make it not ephemeral, unless ephemeral is explicitlyset to false */
  action?: ToastMessageAction;
};

const ONE_YEAR = 1000 * 60 * 60 * 24 * 365;

// Clamp so a flashed toast can never overflow the ~4KB `__message` cookie and 500 in commitSession.
const MAX_TOAST_MESSAGE_LENGTH = 1000;

function clampToastMessage(message: string) {
  if (message.length <= MAX_TOAST_MESSAGE_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_TOAST_MESSAGE_LENGTH)}...`;
}

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

export function setSuccessMessage(
  session: Session,
  message: string,
  options?: ToastMessageOptions
) {
  session.flash("toastMessage", {
    message: clampToastMessage(message),
    type: "success",
    options: {
      ...options,
      ephemeral: options?.ephemeral ?? true,
    },
  } as ToastMessage);
}

export function setErrorMessage(session: Session, message: string, options?: ToastMessageOptions) {
  session.flash("toastMessage", {
    message: clampToastMessage(message),
    type: "error",
    options: {
      ...options,
      ephemeral: options?.ephemeral ?? true,
    },
  } as ToastMessage);
}

export async function setRequestErrorMessage(
  request: Request,
  message: string,
  options?: ToastMessageOptions
) {
  const session = await getSession(request.headers.get("cookie"));

  setErrorMessage(session, message, options);

  return session;
}

export async function setRequestSuccessMessage(
  request: Request,
  message: string,
  options?: ToastMessageOptions
) {
  const session = await getSession(request.headers.get("cookie"));

  setSuccessMessage(session, message, options);

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
  message: string,
  options?: ToastMessageOptions
) {
  const session = await getSession(request.headers.get("cookie"));

  setSuccessMessage(session, message, options);

  return json(data, {
    headers: {
      "Set-Cookie": await commitSession(session, {
        expires: new Date(Date.now() + ONE_YEAR),
      }),
    },
  });
}

export async function jsonWithErrorMessage(
  data: any,
  request: Request,
  message: string,
  options?: ToastMessageOptions
) {
  const session = await getSession(request.headers.get("cookie"));

  setErrorMessage(session, message, options);

  return json(data, {
    headers: {
      "Set-Cookie": await commitSession(session, {
        expires: new Date(Date.now() + ONE_YEAR),
      }),
    },
  });
}

export async function typedJsonWithSuccessMessage<T>(
  data: T,
  request: Request,
  message: string,
  options?: ToastMessageOptions
) {
  const session = await getSession(request.headers.get("cookie"));

  setSuccessMessage(session, message, options);

  return typedjson(data, {
    headers: {
      "Set-Cookie": await commitSession(session, {
        expires: new Date(Date.now() + ONE_YEAR),
      }),
    },
  });
}

export async function typedJsonWithErrorMessage<T>(
  data: T,
  request: Request,
  message: string,
  options?: ToastMessageOptions
) {
  const session = await getSession(request.headers.get("cookie"));

  setErrorMessage(session, message, options);

  return typedjson(data, {
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
  message: string,
  options?: ToastMessageOptions
) {
  const session = await getSession(request.headers.get("cookie"));

  setSuccessMessage(session, message, options);

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
  message: string,
  options?: ToastMessageOptions
) {
  const session = await getSession(request.headers.get("cookie"));

  setErrorMessage(session, message, options);

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
  message: string,
  options?: ToastMessageOptions
) {
  const url = new URL(request.url);
  return redirectWithErrorMessage(url.pathname, request, message, options);
}

export async function redirectBackWithSuccessMessage(
  request: Request,
  message: string,
  options?: ToastMessageOptions
) {
  const url = new URL(request.url);
  return redirectWithSuccessMessage(url.pathname, request, message, options);
}
