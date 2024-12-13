import { ExclamationCircleIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Toaster, toast } from "sonner";

import { useTypedLoaderData } from "remix-typedjson";
import { loader } from "~/root";
import { useEffect } from "react";
import { Paragraph } from "./Paragraph";
import { cn } from "~/utils/cn";

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
      className={cn(
        "self-end rounded-md border border-grid-bright bg-background-dimmed",
        variant === "success" && "border-success",
        variant === "error" && "border-error"
      )}
      style={{
        width: toastWidth,
      }}
    >
      <div className="flex w-full items-start gap-2 rounded-lg p-3">
        {variant === "success" ? (
          <CheckCircleIcon className="mt-1 size-6 min-w-6 text-success" />
        ) : (
          <ExclamationCircleIcon className="mt-1 size-6 min-w-6 text-error" />
        )}
        <Paragraph className="py-1 text-text-bright">{message}</Paragraph>
        <button
          className="hover:bg-midnight-800 ms-auto rounded p-2 text-text-dimmed transition hover:text-text-bright"
          onClick={() => toast.dismiss(t)}
        >
          <XMarkIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
