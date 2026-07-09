import { type ReactNode } from "react";
import { MainHorizontallyCenteredContainer } from "~/components/layout/AppLayout";
import { cn } from "~/utils/cn";
import { Header2, Header3 } from "./Headers";
import { Paragraph } from "./Paragraph";

// A composable layout system for settings pages: a centered container holds
// sections; each section has a header (title/description/action over a divide)
// followed by rows. A row lays out a title + description on the left and an
// action (button/switch/select/status) on the right, separated by divides and
// spacing rather than bordered boxes.
//
// Everything that renders text accepts `ReactNode`, and every piece takes a
// `className` so callers can restyle without forking. For layouts the built-in
// props don't cover, pass `children` to a row/block for full control.

const rowSize = {
  sm: "py-3",
  md: "py-4",
} as const;

type RowSize = keyof typeof rowSize;

/** Page-level wrapper that centers content and sets the settings column width. */
export function SettingsContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <MainHorizontallyCenteredContainer
      className={cn("max-w-[37.5rem] overflow-visible", className)}
    >
      {children}
    </MainHorizontallyCenteredContainer>
  );
}

/** A group of related rows. Adds vertical spacing between sibling sections. */
export function SettingsSection({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("w-full [&:not(:first-child)]:mt-12", className)}>{children}</section>
  );
}

/**
 * Section (or sub-section) heading with an optional description and a
 * right-aligned action, sitting above a bottom divide. Use `as="h3"` for a
 * heading nested inside a section.
 */
export function SettingsHeader({
  title,
  description,
  action,
  as = "h2",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  as?: "h2" | "h3";
  className?: string;
}) {
  const Heading = as === "h3" ? Header3 : Header2;
  return (
    <div
      className={cn(
        "flex w-full items-end justify-between gap-8 border-b border-grid-dimmed",
        // An h2 section header gets its top spacing from SettingsSection's margin,
        // so it only needs bottom padding. An h3 sits mid-section among rows, so it
        // takes the full row rhythm (py-4) to separate from the divide above it.
        as === "h3" ? "py-4" : "pb-3",
        className
      )}
    >
      <div className="space-y-1">
        <Heading>{title}</Heading>
        {description ? <Paragraph variant="small">{description}</Paragraph> : null}
      </div>
      {action ? <div className="flex flex-none items-center">{action}</div> : null}
    </div>
  );
}

/** Title typography for a row. Renders a `<label>` when `htmlFor` is set. */
export function SettingsRowTitle({
  children,
  htmlFor,
  className,
}: {
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  const classes = cn("font-sans text-sm font-semibold leading-tight text-text-bright", className);
  return htmlFor ? (
    <label htmlFor={htmlFor} className={classes}>
      {children}
    </label>
  ) : (
    <span className={classes}>{children}</span>
  );
}

/** Description/subtitle typography for a row. */
export function SettingsRowDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Paragraph variant="small" className={className}>
      {children}
    </Paragraph>
  );
}

/**
 * A single settings row: title + description on the left, action on the right.
 *
 * Pass `title`/`description` for the common case, or `children` to supply
 * custom left-hand content (the built-in title group is skipped when `children`
 * is provided). `action` renders on the right in both cases.
 */
export function SettingsRow({
  title,
  description,
  action,
  htmlFor,
  children,
  className,
  titleClassName,
  size = "md",
  align = "center",
  bordered = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
  className?: string;
  titleClassName?: string;
  size?: RowSize;
  align?: "center" | "start";
  bordered?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full justify-between gap-8",
        align === "center" ? "items-center" : "items-start",
        rowSize[size],
        bordered && "border-b border-grid-dimmed",
        className
      )}
    >
      {children ?? (
        <div className="flex-1 space-y-1">
          {title ? (
            <SettingsRowTitle htmlFor={htmlFor} className={titleClassName}>
              {title}
            </SettingsRowTitle>
          ) : null}
          {description ? <SettingsRowDescription>{description}</SettingsRowDescription> : null}
        </div>
      )}
      {action ? <div className="flex flex-none items-center">{action}</div> : null}
    </div>
  );
}

/**
 * Full-width row for arbitrary content (callouts, empty states, custom blocks)
 * that shouldn't be split into a title/action layout.
 */
export function SettingsBlock({
  children,
  className,
  size = "md",
  bordered = true,
}: {
  children: ReactNode;
  className?: string;
  size?: RowSize;
  bordered?: boolean;
}) {
  return (
    <div
      className={cn("w-full", rowSize[size], bordered && "border-b border-grid-dimmed", className)}
    >
      {children}
    </div>
  );
}

/** Right-aligned action bar, typically for a section's Save button. */
export function SettingsActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex justify-end gap-2 py-4", className)}>{children}</div>;
}
