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
  color?: "blue" | "white" | "muted" | "dark" | CustomColor;
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
    muted: {
      background: "#1C2433",
      foreground: "#3C4B62",
    },
    dark: {
      background: "rgba(18, 19, 23, 0.35)",
      foreground: "#1A1B1F",
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
