import { HomeIcon } from "@heroicons/react/20/solid";
import { isRouteErrorResponse, useRouteError } from "@remix-run/react";
import { motion } from "framer-motion";
import { friendlyErrorDisplay } from "~/utils/httpErrors";
import { LinkButton } from "./primitives/Buttons";
import { Header1 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { type ReactNode, useEffect } from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "spline-viewer": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          url?: string;
          "loading-anim-type"?: string;
        },
        HTMLElement
      >;
    }
  }
}

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
  useEffect(() => {
    // Dynamically load the Spline viewer script
    if (!customElements.get("spline-viewer")) {
      const script = document.createElement("script");
      script.type = "module";
      script.src = "https://unpkg.com/@splinetool/viewer@1.12.29/build/spline-viewer.js";
      document.head.appendChild(script);
    }
  }, []);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-[#16181C]">
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
      <motion.div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 2, ease: "easeOut" }}
      >
        <spline-viewer
          loading-anim-type="spinner-small-light"
          url="https://prod.spline.design/wRly8TZN-e0Twb8W/scene.splinecode"
          style={{ width: "100%", height: "100%" }}
        />
      </motion.div>
    </div>
  );
}
