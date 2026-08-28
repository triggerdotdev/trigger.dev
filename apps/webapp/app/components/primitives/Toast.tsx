import { EnvelopeIcon, ExclamationCircleIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { CheckCircleIcon } from "@heroicons/react/24/solid";
import { useThemeMode } from "~/hooks/useThemeMode";
import { AgentMonoLogo } from "./AgentDotMatrix";
import { useSearchParams } from "@remix-run/react";
import { useEffect, useMemo } from "react";
import { useTypedLoaderData } from "remix-typedjson";
import { Toaster, toast } from "sonner";
import { type ToastMessageAction } from "~/models/message.server";
import { type loader } from "~/root";
import { cn } from "~/utils/cn";
import { Button, LinkButton } from "./Buttons";
import { Header2 } from "./Headers";
import { Paragraph } from "./Paragraph";

const defaultToastDuration = 5000;
const permanentToastDuration = 60 * 60 * 24 * 1000;

export function Toast() {
  const { toastMessage } = useTypedLoaderData<typeof loader>();
  const mode = useThemeMode();
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

  // Sonner stamps its own `data-theme` (default "light") on the toast list and the
  // app's theme selectors follow it, so an unthemed Toaster forces every toast light.
  return <Toaster theme={mode} />;
}

export function useToast() {
  return useMemo(
    () => ({
      success(message: string, options?: { title?: string; ephemeral?: boolean }) {
        const ephemeral = options?.ephemeral ?? true;
        toast.custom(
          (t) => (
            <ToastUI variant="success" message={message} t={t as string} title={options?.title} />
          ),
          { duration: ephemeral ? defaultToastDuration : permanentToastDuration }
        );
      },
      error(message: string, options?: { title?: string; ephemeral?: boolean }) {
        const ephemeral = options?.ephemeral ?? true;
        toast.custom(
          (t) => (
            <ToastUI variant="error" message={message} t={t as string} title={options?.title} />
          ),
          { duration: ephemeral ? defaultToastDuration : permanentToastDuration }
        );
      },
    }),
    []
  );
}

export function ToastUI({
  variant,
  message,
  t,
  toastWidth = 356, // Default width, matches what sonner provides by default
  title,
  action,
  actionNode,
}: {
  variant: "error" | "success" | "agent";
  message: string;
  t: string;
  toastWidth?: string | number;
  title?: string;
  action?: ToastMessageAction;
  /** Caller-rendered action for client-side toasts. `action` stays the serializable server shape. */
  actionNode?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "self-end rounded-md border border-grid-bright bg-background-dimmed",
        variant === "success" && "border-success",
        variant === "error" && "border-error",
        variant === "agent" && "border-[#41FF54]/25 light:border-success/60 dark:bg-secondary"
      )}
      style={{
        width: toastWidth,
      }}
    >
      <div
        className={cn("flex w-full gap-2 rounded-lg p-3", title ? "items-start" : "items-center")}
      >
        {variant === "success" ? (
          <CheckCircleIcon className={cn("size-4 min-w-4 text-success", title && "mt-1")} />
        ) : variant === "agent" ? (
          <span className={cn("flex size-4 min-w-4 items-center", title && "mt-1")}>
            <AgentMonoLogo size={16} decorative />
          </span>
        ) : (
          <ExclamationCircleIcon className={cn("size-4 min-w-4 text-error", title && "mt-1")} />
        )}
        <div className="flex flex-col">
          {title && <Header2 className="pt-0">{title}</Header2>}
          <Paragraph
            variant={title ? "small/dimmed" : "small/bright"}
            className={title ? "pb-1 pt-0.5" : ""}
          >
            {message}
          </Paragraph>
          <Action action={action} toastId={t} className="my-2" />
          {actionNode}
        </div>
        <button
          type="button"
          className={cn(
            "-mr-1 ms-auto rounded p-2 text-text-dimmed transition hover:text-text-bright",
            title && "-mt-1"
          )}
          onClick={() => toast.dismiss(t)}
        >
          <XMarkIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function Action({
  action,
  toastId,
  className,
}: {
  action?: ToastMessageAction;
  toastId: string;
  className?: string;
}) {
  const [_, setSearchParams] = useSearchParams();

  if (!action) return null;

  switch (action.action.type) {
    case "link": {
      return (
        <LinkButton
          className={className}
          variant={action.variant ?? "secondary/small"}
          to={action.action.path}
        >
          {action.label}
        </LinkButton>
      );
    }
    case "help": {
      const feedbackType = action.action.feedbackType;
      return (
        <Button
          className={className}
          variant={action.variant ?? "secondary/small"}
          LeadingIcon={EnvelopeIcon}
          onClick={() => {
            setSearchParams({
              feedbackPanel: feedbackType,
            });
            toast.dismiss(toastId);
          }}
        >
          {action.label}
        </Button>
      );
    }
  }
}
