import { HomeIcon } from "@heroicons/react/20/solid";
import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
import { friendlyErrorDisplay } from "~/utils/httpErrors";
import { permissionDeniedMessage } from "~/utils/permissionDenied";
import { LinkButton } from "./primitives/Buttons";
import { Header1 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { PermissionDenied } from "./PermissionDenied";
import { TriggerRotatingLogo } from "./TriggerRotatingLogo";
import { type ReactNode } from "react";

type ErrorDisplayOptions = {
  button?: {
    title: string;
    to: string;
  };
};

export function RouteErrorDisplay(options?: ErrorDisplayOptions) {
  const error = useRouteError();

  // A failed `authorization` check (or `throwPermissionDenied`) throws a 403
  // that bubbles to the nearest route ErrorBoundary. Every layout boundary
  // renders through here, so handling it once means a gated route only has to
  // declare `authorization` to get the permission panel: no per-route boundary.
  const permission = isRouteErrorResponse(error) ? permissionDeniedMessage(error.data) : null;
  if (permission) {
    return (
      <div className="flex min-h-screen w-full items-center justify-center p-4">
        <div className="w-full max-w-md">
          <PermissionDenied message={permission} />
        </div>
      </div>
    );
  }

  return (
    <>
      {isRouteErrorResponse(error) ? (
        <ErrorDisplay
          title={friendlyErrorDisplay(error.status, error.statusText).title}
          message={
            error.data.message ?? friendlyErrorDisplay(error.status, error.statusText).message
          }
          {...options}
        />
      ) : error instanceof Error ? (
        <ErrorDisplay title={error.name} message={error.message} {...options} />
      ) : (
        <ErrorDisplay title="Oops" message={JSON.stringify(error)} {...options} />
      )}
    </>
  );
}

type DisplayOptionsProps = {
  title: string;
  message?: ReactNode;
} & ErrorDisplayOptions;

export function ErrorDisplay({ title, message, button }: DisplayOptionsProps) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background-dimmed">
      <div className="z-10 mt-[30vh] flex flex-col items-center gap-8">
        <Header1>{title}</Header1>
        {message && <Paragraph>{message}</Paragraph>}
        <LinkButton
          to={button ? button.to : "/"}
          shortcut={{ modifiers: ["mod"], key: "g" }}
          variant="primary/medium"
          LeadingIcon={HomeIcon}
        >
          {button ? button.title : "Go to homepage"}
        </LinkButton>
      </div>
      <TriggerRotatingLogo />
    </div>
  );
}
