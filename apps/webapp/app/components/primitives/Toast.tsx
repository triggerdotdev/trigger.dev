import { ExclamationCircleIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Toaster, toast } from "sonner";

import { useTypedLoaderData } from "remix-typedjson";
import { type loader } from "~/root";
import { useEffect } from "react";
import { Paragraph } from "./Paragraph";

const defaultToastDuration = 5000;
const permanentToastDuration = 60 * 60 * 24 * 1000;

export function Toast() {
  const { toastMessage } = useTypedLoaderData<typeof loader>();
  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const { message, type, options } = toastMessage;

    toast.custom((t) => <ToastUI variant={type} message={message} t={t as string} />, {
      duration: options.ephemeral ? defaultToastDuration : permanentToastDuration,
    });
  }, [toastMessage]);

  return <Toaster />;
}

export function ToastUI({
  variant,
  message,
  t,
  toastWidth = 356, // Default width, matches what sonner provides by default
}: {
  variant: "error" | "success";
  message: string;
  t: string;
  toastWidth?: string | number;
}) {
  return (
    <div
      className={`self-end rounded-md border border-grid-bright bg-background-dimmed`}
      style={{
        width: toastWidth,
      }}
    >
      <div className="flex w-full items-start gap-2 rounded-lg p-3">
        {variant === "success" ? (
          <CheckCircleIcon className="mt-1 h-6 min-h-[1.5rem] w-6 min-w-[1.5rem] text-green-600" />
        ) : (
          <ExclamationCircleIcon className="mt-1 h-6 w-6 min-w-[1.5rem] text-rose-600" />
        )}
        <Paragraph className="py-1 text-text-dimmed">{message}</Paragraph>
        <button
          className="hover:bg-midnight-800 ms-auto rounded p-2 text-text-dimmed transition hover:text-text-bright"
          onClick={() => toast.dismiss(t)}
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
