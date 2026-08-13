import { type CSSProperties, type ReactNode } from "react";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

/* Shared scaffolding for storybook pages: one long scrolling page per component
   (or component group), split into titled sections whose samples sit in a
   responsive grid of labelled cells. */

export function StoryPage({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-10 p-8 pb-24", className)}>
      <div className="space-y-1">
        <Header1>{title}</Header1>
        {description && <Paragraph variant="small">{description}</Paragraph>}
      </div>
      {children}
    </div>
  );
}

export function StorySection({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="space-y-0.5 border-b border-grid-dimmed pb-2">
        <Header2>{title}</Header2>
        {description && <Paragraph variant="extra-small">{description}</Paragraph>}
      </div>
      {children}
    </section>
  );
}

/** Responsive auto-fill grid; tune the cell floor with `min`. */
export function StoryGrid({
  children,
  min = "12rem",
  className,
}: {
  children: ReactNode;
  min?: string;
  className?: string;
}) {
  return (
    <div
      className={cn("grid gap-3", className)}
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}, 1fr))` } as CSSProperties}
    >
      {children}
    </div>
  );
}

/** One labelled sample. */
export function Story({
  label,
  children,
  className,
  contentClassName,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 rounded-sm border border-grid-dimmed p-3", className)}>
      <Paragraph variant="extra-extra-small/caps" className="text-text-dimmed">
        {label}
      </Paragraph>
      <div className={cn("flex min-h-8 flex-1 items-center", contentClassName)}>{children}</div>
    </div>
  );
}
