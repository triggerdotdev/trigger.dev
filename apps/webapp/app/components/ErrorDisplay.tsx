import { HomeIcon } from "@heroicons/react/20/solid";
import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
import { friendlyErrorDisplay } from "~/utils/httpErrors";
import { LinkButton } from "./primitives/Buttons";
import { Header1 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { type ReactNode } from "react";

type ErrorDisplayOptions = {
  button?: {
    title: string;
    to: string;
  };
};

export function RouteErrorDisplay(options?: ErrorDisplayOptions) {
  const error = useRouteError();

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
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#16181C]">
      <div className="flex flex-col items-center gap-8">
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
    </div>
  );
}
