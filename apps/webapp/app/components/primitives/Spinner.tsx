import { AgentMonoLogo } from "~/components/primitives/AgentDotMatrix";
import { cn } from "~/utils/cn";

type CustomColor = {
  background: string;
  foreground: string;
};

export function Spinner({
  className,
  color = "blue",
}: {
  className?: string;
  color?: "blue" | "white" | "muted" | "dark" | "inherit" | CustomColor;
}) {
  const colors = {
    blue: {
      background: "rgba(59, 130, 246, 0.4)",
      foreground: "rgba(59, 130, 246)",
    },
    white: {
      background: "rgba(255, 255, 255, 0.4)",
      foreground: "rgba(255, 255, 255)",
    },
    /* Theme tokens rather than fixed values, so a muted spinner stays muted
       against a light surface instead of staying dark-theme navy. */
    muted: {
      background: "var(--color-grid-bright)",
      foreground: "var(--color-text-dimmed)",
    },
    dark: {
      background: "color-mix(in srgb, var(--color-charcoal-900) 35%, transparent)",
      foreground: "var(--color-charcoal-900)",
    },
    /* Takes the surrounding text color, so it follows both the theme and
       whatever it sits on - white on a primary button, dark ink on a
       secondary one once the theme is light. */
    inherit: {
      background: "color-mix(in srgb, currentColor 40%, transparent)",
      foreground: "currentColor",
    },
  };

  const currentColor = typeof color === "string" ? colors[color] : color;

  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("animate-spin motion-reduce:hidden", className)}
    >
      <rect
        x="2"
        y="2"
        width="16"
        height="16"
        rx="8"
        stroke={currentColor.background}
        strokeWidth="3"
      />
      <path
        d="M10 18C5.58172 18 2 14.4183 2 10C2 5.58172 5.58172 2 10 2"
        stroke={currentColor.foreground}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ButtonSpinner() {
  return (
    <Spinner
      className="size-3"
      color={{
        background: "rgba(255, 255, 255, 0.4)",
        foreground: "rgba(255, 255, 255)",
      }}
    />
  );
}

export function SpinnerWhite({ className }: { className?: string }) {
  return <Spinner className={className} color="white" />;
}

/** The dashboard agent's spinner. `size` is the logo's pixel size; the matrix does not scale from CSS. */
export function AgentSpinner({ size = 16 }: { size?: number }) {
  return (
    <AgentMonoLogo
      size={size}
      active
      // Resting on the playlist's first shape avoids a logo-head flash on mount.
      restShape="square"
      decorative
    />
  );
}
