// Components with Mintlify's names and props, so trigger.dev/docs renders unchanged,
// drawn with the dashboard's tokens (app/global.css).
import {
  Children,
  Fragment,
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import Link from "fumadocs-core/link";
import { CircleCheck, Info as InfoIcon, Lightbulb, TriangleAlert } from "lucide-react";
import {
  Tabs as FTabs,
  Tab as FTab,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "fumadocs-ui/components/tabs";
import {
  CodeBlockTab,
  CodeBlockTabs,
  CodeBlockTabsList,
  CodeBlockTabsTrigger,
} from "fumadocs-ui/components/codeblock";
import { groupChoices } from "@/lib/choices";
import { ChoiceTabs } from "./choice-tabs";
import { Disclosure } from "./disclosure";
import { Icon } from "./icons";
import { withBase } from "@/lib/base-path";

export { Icon };

type Children = { children?: ReactNode };
type CalloutProps = Children & { title?: ReactNode };

// One callout, four kinds. The accent rides on --tone so a kind is one variable, not a class set.
function CalloutBox({
  kind,
  icon,
  title,
  children,
}: CalloutProps & { kind: "note" | "warning" | "tip" | "check"; icon: ReactNode }) {
  return (
    <div
      role="note"
      style={
        {
          "--tone": `var(--callout-${kind})`,
          "--tint": `var(--callout-${kind}-tint)`,
        } as CSSProperties
      }
      className="my-5 flex gap-3 rounded-lg border border-[color-mix(in_srgb,var(--tone)_28%,transparent)] bg-(--tint) px-4 py-3 text-[0.875rem] leading-relaxed"
    >
      <span className="mt-[3px] shrink-0 text-(--tone) [&>svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1 text-fd-foreground [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-2">
        {title && <p className="font-semibold text-(--color-text-bright)">{title}</p>}
        {children}
      </div>
    </div>
  );
}

export const Note = (p: CalloutProps) => <CalloutBox kind="note" icon={<InfoIcon />} {...p} />;
export const Info = Note;
export const Warning = (p: CalloutProps) => (
  <CalloutBox kind="warning" icon={<TriangleAlert />} {...p} />
);
export const Tip = (p: CalloutProps) => <CalloutBox kind="tip" icon={<Lightbulb />} {...p} />;
export const Check = (p: CalloutProps) => <CalloutBox kind="check" icon={<CircleCheck />} {...p} />;
export const Callout = ({ icon, children }: Children & { icon?: ReactNode; color?: string }) => (
  <CalloutBox kind="note" icon={icon ? <Icon icon={icon} /> : <InfoIcon />}>
    {children}
  </CalloutBox>
);

export function Card({
  title,
  icon,
  href,
  img,
  horizontal,
  cta,
  children,
}: Children & {
  title?: ReactNode;
  icon?: ReactNode;
  href?: string;
  img?: string;
  horizontal?: boolean;
  color?: string;
  cta?: string;
}) {
  const body = (
    <>
      {img && <img src={withBase(img)} alt="" className="mb-3 w-full rounded-md" loading="lazy" />}
      <div className={horizontal ? "flex items-center gap-3" : ""}>
        {icon && (
          <span
            className={`flex size-8 shrink-0 items-center justify-center rounded-md border border-fd-border bg-fd-muted text-fd-primary ${horizontal ? "" : "mb-3"}`}
          >
            <Icon icon={icon} size={16} className="" />
          </span>
        )}
        <div className="min-w-0">
          {title && (
            <p className="text-[0.9375rem] font-semibold leading-snug text-(--color-text-bright)">
              {title}
            </p>
          )}
          {children && (
            <div className="mt-1 text-[0.8125rem] leading-relaxed text-fd-muted-foreground [&_p]:m-0 [&_p+p]:mt-2">
              {children}
            </div>
          )}
          {cta && <p className="mt-2 text-[0.8125rem] font-medium text-fd-primary">{cta}</p>}
        </div>
      </div>
    </>
  );
  const cls =
    "not-prose group block rounded-lg border border-fd-border bg-fd-card p-4 transition-colors";
  if (!href) return <div className={cls}>{body}</div>;
  return (
    <Link
      href={href}
      className={`${cls} hover:border-[color-mix(in_srgb,var(--color-fd-primary)_45%,var(--color-fd-border))] hover:bg-(--color-surface-hover) focus-visible:outline-2 focus-visible:outline-fd-ring`}
    >
      {body}
    </Link>
  );
}

export function CardGroup({ cols = 2, children }: Children & { cols?: number }) {
  const n = Math.min(Math.max(cols, 1), 4);
  return (
    <div
      className="not-prose my-6 grid gap-3 sm:[grid-template-columns:repeat(min(var(--cols),2),minmax(0,1fr))] lg:[grid-template-columns:repeat(var(--cols),minmax(0,1fr))]"
      style={{ "--cols": n } as CSSProperties}
    >
      {children}
    </div>
  );
}

// Steps are a real sequence, so they are numbered: a counter per Steps, joined by a rail.
export const Steps = ({ children }: Children) => (
  <div className="my-6 [counter-reset:step]">{children}</div>
);
export const Step = ({
  title,
  children,
}: Children & { title?: ReactNode; icon?: string; stepNumber?: number }) => (
  <div className="relative pb-6 pl-10 [counter-increment:step] last:pb-0 before:absolute before:top-0 before:left-0 before:flex before:size-6 before:items-center before:justify-center before:rounded-full before:border before:border-fd-border before:bg-fd-muted before:font-mono before:text-xs before:font-medium before:text-fd-foreground before:content-[counter(step)] after:absolute after:top-8 after:bottom-1 after:left-3 after:w-px after:bg-fd-border last:after:hidden [&>:last-child]:mb-0 [&>:nth-child(2)]:mt-0">
    {title && (
      <div className="mb-2 text-[0.9375rem] leading-6 font-semibold text-(--color-text-bright)">
        {title}
      </div>
    )}
    {children}
  </div>
);

const elements = (children: ReactNode) =>
  Children.toArray(children).filter(isValidElement) as ReactElement<Record<string, unknown>>[];

export function Tabs({ children }: Children) {
  const tabs = elements(children);
  const titles = tabs.map((t, i) => String(t.props.title ?? `Tab ${i + 1}`));
  const choices = groupChoices(titles);
  if (choices) {
    const values = titles.map((_, i) => `${i}`);
    const attr = (i: number) => ({ [`data-choice-${choices.kind}`]: choices.slugs[i] });
    // All panels are rendered so the layout's CSS can show the reader's choice before hydration.
    return (
      <ChoiceTabs kind={choices.kind} slugs={choices.slugs} values={values} variant="tabs">
        <TabsList>
          {titles.map((t, i) => (
            <TabsTrigger key={i} value={values[i]!} {...attr(i)}>
              {t}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((t, i) => (
          <TabsContent key={i} value={values[i]!} forceMount {...attr(i)}>
            {t.props.children as ReactNode}
          </TabsContent>
        ))}
      </ChoiceTabs>
    );
  }
  return (
    <FTabs items={titles}>
      {tabs.map((t, i) => (
        <FTab key={titles[i]} value={titles[i]}>
          {t.props.children as ReactNode}
        </FTab>
      ))}
    </FTabs>
  );
}
// Rendered by Tabs, which reads its title.
export const Tab = ({ children }: Children & { title?: string }) => <>{children}</>;

// Tabs over the child code blocks, labelled by each block's title (from the fence meta).
export function CodeGroup({ children }: Children) {
  // rehype-code output arrives wrapped in a Fragment; the title is on the <pre> inside it.
  const blocks = elements(children).map((b) =>
    b.type === Fragment ? (elements(b.props.children as ReactNode)[0] ?? b) : b
  );
  const titles = blocks.map((b, i) => String(b.props.title ?? `Code ${i + 1}`));
  const choices = groupChoices(titles);
  if (choices) {
    const values = titles.map((_, i) => `${i}`);
    const attr = (i: number) => ({ [`data-choice-${choices.kind}`]: choices.slugs[i] });
    return (
      <ChoiceTabs kind={choices.kind} slugs={choices.slugs} values={values} variant="code">
        <CodeBlockTabsList>
          {titles.map((t, i) => (
            <CodeBlockTabsTrigger key={i} value={values[i]!} {...attr(i)}>
              {t}
            </CodeBlockTabsTrigger>
          ))}
        </CodeBlockTabsList>
        {blocks.map((b, i) => (
          <CodeBlockTab
            key={i}
            value={values[i]!}
            forceMount
            className="data-[state=inactive]:hidden"
            {...attr(i)}
          >
            {cloneElement(b, { title: undefined })}
          </CodeBlockTab>
        ))}
      </ChoiceTabs>
    );
  }
  return (
    <CodeBlockTabs defaultValue={`${0}`}>
      <CodeBlockTabsList>
        {titles.map((t, i) => (
          <CodeBlockTabsTrigger key={i} value={`${i}`}>
            {t}
          </CodeBlockTabsTrigger>
        ))}
      </CodeBlockTabsList>
      {blocks.map((b, i) => (
        <CodeBlockTab key={i} value={`${i}`}>
          {cloneElement(b, { title: undefined })}
        </CodeBlockTab>
      ))}
    </CodeBlockTabs>
  );
}

export function Accordion({
  title,
  description,
  defaultOpen,
  icon,
  children,
}: Children & {
  title?: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  icon?: string;
}) {
  return (
    <Disclosure
      variant="accordion"
      defaultOpen={defaultOpen}
      summary={
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          {icon && <Icon icon={icon} size={15} className="self-center text-fd-muted-foreground" />}
          <span>{title}</span>
          {description && (
            <span className="text-[0.8125rem] font-normal text-fd-muted-foreground">
              {description}
            </span>
          )}
        </span>
      }
    >
      {children}
    </Disclosure>
  );
}
export const AccordionGroup = ({ children }: Children) => <div className="my-6">{children}</div>;

export const Expandable = ({
  title = "properties",
  defaultOpen,
  children,
}: Children & { title?: ReactNode; defaultOpen?: boolean }) => (
  <Disclosure variant="expandable" summary={title} defaultOpen={defaultOpen}>
    {children}
  </Disclosure>
);

type FieldProps = Children & {
  type?: string;
  required?: boolean;
  default?: unknown;
  deprecated?: boolean;
};

const Pill = ({ tone, children }: Children & { tone: string }) => (
  <span
    className="rounded px-1.5 py-px text-[0.6875rem] font-medium"
    style={{ color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)` }}
  >
    {children}
  </span>
);

// One row per field, like an API reference: name, type and flags on one line, description below.
function Field({
  name,
  location,
  type,
  required,
  default: def,
  deprecated,
  children,
}: FieldProps & { name?: string; location?: string }) {
  return (
    <div className="border-b border-fd-border py-4 first:pt-2 last:border-b-0 [&_.border-b]:last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.8125rem]">
        <span
          className={`font-semibold text-(--color-text-bright) ${deprecated ? "line-through decoration-fd-muted-foreground" : ""}`}
        >
          {name}
        </span>
        {type && <span className="text-fd-muted-foreground">{type}</span>}
        {location && <span className="text-fd-muted-foreground/70">{location}</span>}
        <span className="flex gap-1.5 font-sans">
          {required && <Pill tone="#e5484d">required</Pill>}
          {deprecated && <Pill tone="var(--callout-warning)">deprecated</Pill>}
        </span>
        {def !== undefined && (
          <span className="font-sans text-xs text-fd-muted-foreground">
            Default:{" "}
            <code className="font-mono text-fd-foreground">
              {typeof def === "string" ? def : JSON.stringify(def)}
            </code>
          </span>
        )}
      </div>
      {children && (
        <div className="mt-1.5 text-[0.875rem] leading-relaxed text-fd-muted-foreground [&_p]:my-1.5 [&>:first-child]:mt-0">
          {children}
        </div>
      )}
    </div>
  );
}

export function ParamField({
  path,
  query,
  body,
  header,
  ...rest
}: FieldProps & {
  path?: string;
  query?: string;
  body?: string;
  header?: string;
  placeholder?: string;
}) {
  const [location, name] =
    path != null
      ? ["path", path]
      : query != null
        ? ["query", query]
        : header != null
          ? ["header", header]
          : [undefined, body];
  return <Field name={name} location={location} {...rest} />;
}
export const ResponseField = ({ name, ...rest }: FieldProps & { name?: string }) => (
  <Field name={name} {...rest} />
);

export const Frame = ({ caption, children }: Children & { caption?: ReactNode; hint?: string }) => (
  <figure className="not-prose my-6">
    <div className="overflow-hidden rounded-lg border border-fd-border bg-fd-card p-1.5 [&_img]:m-0 [&_img]:rounded-md [&_video]:rounded-md">
      {children}
    </div>
    {caption && (
      <figcaption className="mt-2 text-center text-[0.8125rem] text-fd-muted-foreground">
        {caption}
      </figcaption>
    )}
  </figure>
);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Changelog entry: the date sticks beside the entry on wide screens, a timeline rail joins them.
export function Update({
  label,
  description,
  tags,
  children,
}: Children & { label: string; description?: ReactNode; tags?: string[] }) {
  return (
    <section className="relative grid gap-3 border-l border-fd-border pb-10 pl-6 md:grid-cols-[9rem_minmax(0,1fr)] md:gap-8 md:border-l-0 md:pl-0">
      <span
        aria-hidden
        className="absolute top-1.5 -left-[5px] size-2.5 rounded-full border-2 border-fd-background bg-fd-primary md:hidden"
      />
      <div className="md:sticky md:top-24 md:self-start">
        <a
          id={slug(label)}
          href={`#${slug(label)}`}
          className="font-mono text-[0.8125rem] font-medium text-(--color-text-bright) no-underline hover:text-fd-primary"
        >
          {label}
        </a>
        {description && (
          <div className="mt-0.5 text-[0.8125rem] text-fd-muted-foreground">{description}</div>
        )}
        {tags && tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {tags.map((t) => (
              <span
                key={t}
                className="rounded border border-fd-border px-1.5 text-[0.6875rem] text-fd-muted-foreground"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="min-w-0 [&>:first-child]:mt-0">{children}</div>
    </section>
  );
}

// Mintlify shows these beside API pages; we render them inline.
export const RequestExample = ({ children }: Children) => <div className="my-4">{children}</div>;
export const ResponseExample = RequestExample;

// `<Visibility for="agents">` is for the markdown agents read, not the page.
export const Visibility = ({ for: audience, children }: Children & { for?: string }) =>
  audience === "humans" ? <>{children}</> : null;
