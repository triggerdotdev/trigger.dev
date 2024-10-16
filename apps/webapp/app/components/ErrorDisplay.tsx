import { HomeIcon } from "@heroicons/react/20/solid";
import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
import { friendlyErrorDisplay } from "~/utils/httpErrors";
import logoGlow from "../assets/images/logo-glow.png";
import { LinkButton } from "./primitives/Buttons";
import { Header1, Header3 } from "./primitives/Headers";

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
  message?: string;
} & ErrorDisplayOptions;

export function ErrorDisplay({ title, message, button }: DisplayOptionsProps) {
  return (
    <div className="relative mt-32 flex flex-col items-center gap-6">
      <div className="pointer-events-none absolute left-1/2 top-[220px] z-20 w-[350px] -translate-x-1/2 animate-[ping-pong-width_10s_ease-in-out_infinite]">
        <img src={logoGlow} className="h-full w-full object-contain" />
      </div>
      <div className="pointer-events-none absolute left-1/2 top-[230px] z-10 h-[70px] w-[350px] -translate-x-1/2 bg-background-dimmed" />
      <iframe
        src="https://my.spline.design/rotatinglogo-dd8c81cb0ec1b9d7d09a7b473b2992e2/"
        width="200px"
        height="300px"
      />
      <Header1>{title}</Header1>
      {message && <Header3>{message}</Header3>}
      <LinkButton to={button ? button.to : "/"} variant="primary/medium" LeadingIcon={HomeIcon}>
        {button ? button.title : "Go to homepage"}
      </LinkButton>
    </div>
  );
}
