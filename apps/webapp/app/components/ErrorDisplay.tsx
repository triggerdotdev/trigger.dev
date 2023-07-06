import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
import { LinkButton } from "./primitives/Buttons";
import { Header1, Header3 } from "./primitives/Headers";
import { friendlyErrorDisplay } from "~/utils/httpErrors";

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
            error.data.message ??
            friendlyErrorDisplay(error.status, error.statusText).message
          }
          {...options}
        />
      ) : error instanceof Error ? (
        <ErrorDisplay title={error.name} message={error.message} {...options} />
      ) : (
        <ErrorDisplay
          title="Oops"
          message={JSON.stringify(error)}
          {...options}
        />
      )}
    </>
  );
}

type DisplayOptionsProps = {
  title: string;
  message?: string;
} & ErrorDisplayOptions;

export function ErrorDisplay({ title, message, button }: DisplayOptionsProps) {
  return (
    <div className="p-4">
      <Header1 className="mb-4 border-b border-slate-800 pb-4">{title}</Header1>
      {message && <Header3>{message}</Header3>}
      <LinkButton
        to={button ? button.to : "/"}
        variant="primary/medium"
        className="mt-8"
      >
        {button ? button.title : "Home"}
      </LinkButton>
    </div>
  );
}
