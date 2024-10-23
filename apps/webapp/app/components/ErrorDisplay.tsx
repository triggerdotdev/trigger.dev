import { HomeIcon } from "@heroicons/react/20/solid";
import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
import { motion } from "framer-motion";
import { friendlyErrorDisplay } from "~/utils/httpErrors";
import { LinkButton } from "./primitives/Buttons";
import { Header1 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";

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
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-[#16181C]">
      <div className="z-10 mt-[30vh] flex flex-col items-center gap-8">
        <Header1>{title}</Header1>
        {message && <Paragraph>{message}</Paragraph>}
        <LinkButton
          to={button ? button.to : "/"}
          shortcut={{ modifiers: ["meta"], key: "g" }}
          variant="primary/medium"
          LeadingIcon={HomeIcon}
        >
          {button ? button.title : "Go to homepage"}
        </LinkButton>
      </div>
      <div className="pointer-events-none absolute bottom-4 right-4 z-10 h-[70px] w-[200px] bg-[rgb(24,26,30)]" />
      <motion.div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 2, ease: "easeOut" }}
      >
        <iframe
          src="https://my.spline.design/untitled-a6f70b5ebc46bdb2dcc0f21d5397e8ac/"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          style={{ border: "none" }}
        />
      </motion.div>
    </div>
  );
}
