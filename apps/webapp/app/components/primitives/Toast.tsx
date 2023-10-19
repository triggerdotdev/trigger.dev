import { ExclamationCircleIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Toaster, toast } from "sonner";

import { useTypedLoaderData } from "remix-typedjson";
import { loader } from "~/root";
import { useEffect } from "react";

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
      className={`self-end rounded-lg border border-slate-750 bg-midnight-900 shadow-md`}
      style={{
        width: toastWidth,
      }}
    >
      <div
        className="flex w-full gap-2 rounded-lg bg-no-repeat p-4 text-bright"
        style={{
          background:
            "radial-gradient(at top, hsla(271, 91%, 65%, 0.18), hsla(221, 83%, 53%, 0.18)) hsla(221, 83%, 53%, 0.18)",
        }}
      >
        {variant === "success" ? (
          <CheckCircleIcon className="h-6 w-6 text-green-600" />
        ) : (
          <ExclamationCircleIcon className="h-6 w-6 text-rose-600" />
        )}
        {message}
        <button className="ms-auto p-1" onClick={() => toast.dismiss(t)}>
          <XMarkIcon className="h-4 w-4 text-bright" />
        </button>
      </div>
    </div>
  );
}
