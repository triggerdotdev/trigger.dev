import { EnvelopeIcon, ExclamationCircleIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { Toaster, toast } from "sonner";
import { useTypedLoaderData } from "remix-typedjson";
import { type loader } from "~/root";
import { useEffect } from "react";
import { Paragraph } from "./Paragraph";
import { cn } from "~/utils/cn";
import { type ToastMessageAction } from "~/models/message.server";
import { Header2, Header3 } from "./Headers";
import { Button, LinkButton } from "./Buttons";
import { Feedback } from "../Feedback";
import assertNever from "assert-never";
import { assertExhaustive } from "@trigger.dev/core";

const defaultToastDuration = 5000;
const permanentToastDuration = 60 * 60 * 24 * 1000;

export function Toast() {
  const { toastMessage } = useTypedLoaderData<typeof loader>();
  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const { message, type, options } = toastMessage;

    const ephemeral = options.action ? false : options.ephemeral;

    toast.custom(
      (t) => (
        <ToastUI
          variant={type}
          message={message}
          t={t as string}
          title={options.title}
          action={options.action}
        />
      ),
      {
        duration: ephemeral ? defaultToastDuration : permanentToastDuration,
      }
    );
  }, [toastMessage]);

  return <Toaster />;
}

export function ToastUI({
  variant,
  message,
  t,
  toastWidth = 356, // Default width, matches what sonner provides by default
  title,
  action,
}: {
  variant: "error" | "success";
  message: string;
  t: string;
  toastWidth?: string | number;
  title?: string;
  action?: ToastMessageAction;
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
          <CheckCircleIcon className="mt-1 size-4 min-w-4 text-success" />
        ) : (
          <ExclamationCircleIcon className="mt-1 size-4 min-w-4 text-error" />
        )}
        <div className="flex flex-col">
          {title && <Header2 className="pt-1">{title}</Header2>}
          <Paragraph variant="small/dimmed" className="py-1">
            {message}
          </Paragraph>
          <Action action={action} toastId={t} />
        </div>
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

function Action({ action, toastId }: { action?: ToastMessageAction; toastId: string }) {
  if (!action) return null;

  switch (action.action.type) {
    case "link": {
      return (
        <LinkButton variant={action.variant ?? "secondary/small"} to={action.action.path}>
          {action.label}
        </LinkButton>
      );
    }
    case "help": {
      return (
        <Feedback
          button={
            <Button
              variant={action.variant ?? "secondary/small"}
              LeadingIcon={EnvelopeIcon}
              onClick={(e) => {
                e.preventDefault();
                toast.dismiss(toastId);
              }}
            >
              {action.label}
            </Button>
          }
        />
      );
    }
    default: {
      return null;
    }
  }
}
