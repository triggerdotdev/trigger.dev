import { type CSSProperties, type ReactNode } from "react";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Header1, Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

/** The component's file name, copyable on hover. Pass every file a page covers. */
export function ComponentNames({ names }: { names: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {names.map((name) => (
        <CopyableText key={name} value={name} className="font-mono text-xs text-text-dimmed" />
      ))}
    </div>
  );
}

export function StoryPage({
  title,
  componentNames,
  description,
  children,
  className,
}: {
  title: string;
  /** File names of the components shown, e.g. ["Buttons.tsx"]. */
  componentNames?: string[];
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-10 p-8 pb-24", className)}>
      <div className="space-y-1.5">
        <Header1>{title}</Header1>
        {componentNames && componentNames.length > 0 && <ComponentNames names={componentNames} />}
        {description && <Paragraph variant="small">{description}</Paragraph>}
      </div>
      {children}
    </div>
  );
}

export function StorySection({
  title,
  componentName,
  description,
  children,
  className,
}: {
  title: string;
  /** Shown beside the heading when a page covers several component files. */
  componentName?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="space-y-0.5 border-b border-grid-dimmed pb-2">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <Header2>{title}</Header2>
          {componentName && (
            <CopyableText value={componentName} className="font-mono text-xs text-text-dimmed" />
          )}
        </div>
        {description && <Paragraph variant="extra-small">{description}</Paragraph>}
      </div>
      {children}
    </section>
  );
}

/** Sub-heading inside a section, for grouping variants of one component. */
export function StorySubSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <Header3 className="text-text-dimmed">{title}</Header3>
      {children}
    </div>
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
