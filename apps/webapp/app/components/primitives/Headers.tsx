import { cn } from "~/utils/cn";

const headerVariants = {
  header1: {
    text: "font-sans text-base md:text-lg lg:text-xl leading-5 md:leading-6 lg:leading-7 font-semibold",
    spacing: "mb-2",
  },
  header2: {
    text: "font-sans text-base leading-6 font-medium",
    spacing: "mb-2",
  },
  header3: {
    text: "font-sans text-sm leading-5 font-medium",
    spacing: "mb-2",
  },
};

const textColorVariants = {
  bright: "text-bright",
  dimmed: "text-dimmed",
};

export type HeaderVariant = keyof typeof headerVariants;

type HeaderProps = {
  className?: string;
  children: React.ReactNode;
  spacing?: boolean;
  textColor?: "bright" | "dimmed";
} & React.HTMLAttributes<HTMLHeadingElement>;

export function Header1({
  className,
  children,
  spacing = false,
  textColor = "bright",
}: HeaderProps) {
  return (
    <h1
      className={cn(
        headerVariants.header1.text,
        spacing === true && headerVariants.header1.spacing,
        textColor === "bright"
          ? textColorVariants.bright
          : textColorVariants.dimmed,
        className
      )}
    >
      {children}
    </h1>
  );
}

export function Header2({
  className,
  children,
  spacing = false,
  textColor = "bright",
}: HeaderProps) {
  return (
    <h2
      className={cn(
        headerVariants.header2.text,
        spacing === true && headerVariants.header2.spacing,
        textColor === "bright"
          ? textColorVariants.bright
          : textColorVariants.dimmed,
        className
      )}
    >
      {children}
    </h2>
  );
}

export function Header3({
  className,
  children,
  spacing = false,
  textColor = "bright",
}: HeaderProps) {
  return (
    <h3
      className={cn(
        headerVariants.header3.text,
        spacing === true && headerVariants.header3.spacing,
        textColor === "bright"
          ? textColorVariants.bright
          : textColorVariants.dimmed,
        className
      )}
    >
      {children}
    </h3>
  );
}
