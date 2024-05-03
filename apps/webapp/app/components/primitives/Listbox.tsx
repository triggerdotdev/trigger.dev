import * as Ariakit from "@ariakit/react";
import { SelectProps as AriaSelectProps } from "@ariakit/react";
import { SelectValue } from "@ariakit/react-core/select/select-value";
import * as React from "react";
import { Fragment, useMemo, useState } from "react";
import { ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { ShortcutKey } from "./ShortcutKey";
import { Link } from "@remix-run/react";

const sizes = {
  small: {
    button: "h-6 rounded text-xs pr-2 pl-1.5",
  },
  medium: {
    button: "h-8 rounded text-xs pr-2 pl-1.5",
  },
};

const variants = {
  "tertiary/small": {
    button: cn(
      sizes.small.button,
      "bg-tertiary focus-within:ring-charcoal-500 border border-tertiary hover:text-text-bright hover:border-charcoal-600"
    ),
  },
};

type Variant = keyof typeof variants;

type Section<TItem> = {
  type: "section";
  title?: string;
  items: TItem[];
};

function isSection<TItem>(data: TItem[] | Section<TItem>[]): data is Section<TItem>[] {
  const firstItem = data[0];
  return (
    (firstItem as Section<TItem>).type === "section" &&
    (firstItem as Section<TItem>).items !== undefined &&
    Array.isArray((firstItem as Section<TItem>).items)
  );
}

type ItemFromSection<TItemOrSection> = TItemOrSection extends Section<infer U> ? U : TItemOrSection;

export interface SelectProps<TValue extends string | string[], TItem>
  extends Omit<Ariakit.SelectProps, "children"> {
  icon?: React.ReactNode;
  text?: React.ReactNode;
  value?: Ariakit.SelectProviderProps<TValue>["value"];
  setValue?: Ariakit.SelectProviderProps<TValue>["setValue"];
  defaultValue?: Ariakit.SelectProviderProps<TValue>["defaultValue"];
  tab?: Ariakit.TabProviderProps["selectedId"];
  setTab?: Ariakit.TabProviderProps["setSelectedId"];
  defaultTab?: Ariakit.TabProviderProps["defaultSelectedId"];
  selectTabOnMove?: boolean;
  label?: string | Ariakit.SelectLabelProps["render"];
  heading?: string;
  showHeading?: boolean;
  items?: TItem[] | Section<TItem>[];
  empty?: React.ReactNode;
  filter?: (item: ItemFromSection<TItem>, search: string, title?: string) => boolean;
  children:
    | React.ReactNode
    | ((
        items: ItemFromSection<TItem>[],
        meta: {
          shortcutsEnabled?: boolean;
          section?: {
            title?: string;
            startIndex: number;
            count: number;
          };
        }
      ) => React.ReactNode);
  variant?: Variant;
  open?: boolean;
  setOpen?: (open: boolean) => void;
  shortcut?: ShortcutDefinition;
  allowItemShortcuts?: boolean;
}

export function Select<TValue extends string | string[], TItem>({
  children,
  icon,
  text,
  value,
  setValue,
  defaultValue,
  tab,
  setTab,
  defaultTab,
  selectTabOnMove,
  label,
  heading,
  showHeading = false,
  items,
  filter,
  empty = null,
  variant = "tertiary/small",
  open,
  setOpen,
  shortcut,
  allowItemShortcuts = true,
  disabled,
  ...props
}: SelectProps<TValue, TItem>) {
  const [searchValue, setSearchValue] = useState("");
  const searchable = items !== undefined && filter !== undefined;

  const matches = useMemo(() => {
    if (!items) return [];
    if (!searchValue || !filter) return items;

    if (isSection(items)) {
      return items
        .map((section) => ({
          ...section,
          items: section.items.filter((item) =>
            filter(item as ItemFromSection<TItem>, searchValue, section.title)
          ),
        }))
        .filter((section) => section.items.length > 0);
    }

    return items.filter((item) => filter(item as ItemFromSection<TItem>, searchValue));
  }, [searchValue, items]);

  const enableItemShortcuts = allowItemShortcuts && matches.length === items?.length;

  const select = (
    <Ariakit.SelectProvider
      open={open}
      setOpen={setOpen}
      virtualFocus={searchable}
      value={value}
      setValue={setValue}
      defaultValue={defaultValue}
    >
      {label && (
        <Ariakit.SelectLabel render={typeof label === "string" ? <div>{label}</div> : label} />
      )}
      <SelectTrigger
        icon={icon}
        variant={variant}
        text={text}
        shortcut={shortcut}
        tooltipTitle={heading}
        disabled={disabled}
      />
      <Ariakit.SelectPopover
        gutter={5}
        shift={0}
        unmountOnHide
        className={cn(
          "z-50 flex flex-col overflow-clip rounded border border-charcoal-700 bg-background-bright shadow-md outline-none animate-in fade-in-40",
          "min-w-[max(180px,calc(var(--popover-anchor-width)+0.5rem))]",
          "max-w-[min(480px,var(--popover-available-width))]",
          "max-h-[min(480px,var(--popover-available-height))]",
          "origin-[var(--popover-transform-origin)]"
        )}
      >
        {!searchable && showHeading && heading && <SelectHeading render={<>{heading}</>} />}
        {searchable && (
          <div className="flex h-9 w-full flex-none items-center border-b border-grid-dimmed bg-transparent px-3 text-xs text-text-dimmed outline-none">
            <Ariakit.Combobox
              autoSelect
              render={<input placeholder={heading ?? "Filter options"} />}
              className="flex-1 bg-transparent text-xs text-text-dimmed outline-none"
            />
            {shortcut && (
              <ShortcutKey
                className={cn("size-4 flex-none")}
                shortcut={shortcut}
                variant={"small"}
              />
            )}
          </div>
        )}
        <Ariakit.TabProvider
          selectedId={tab}
          setSelectedId={setTab}
          defaultSelectedId={defaultTab}
          selectOnMove={selectTabOnMove}
        >
          <div className="flex flex-col overflow-hidden">
            <SelectList>
              {typeof children === "function" ? (
                matches.length > 0 ? (
                  isSection(matches) ? (
                    <SelectGroupedRenderer
                      items={matches}
                      children={children}
                      enableItemShortcuts={enableItemShortcuts}
                    />
                  ) : (
                    children(matches as ItemFromSection<TItem>[], {
                      shortcutsEnabled: enableItemShortcuts,
                    })
                  )
                ) : (
                  empty
                )
              ) : (
                children
              )}
            </SelectList>
          </div>
        </Ariakit.TabProvider>
      </Ariakit.SelectPopover>
    </Ariakit.SelectProvider>
  );

  if (searchable) {
    return (
      <Ariakit.ComboboxProvider
        resetValueOnHide
        setValue={(value) => {
          React.startTransition(() => {
            setSearchValue(value);
          });
        }}
      >
        {select}
      </Ariakit.ComboboxProvider>
    );
  }

  return select;
}

export interface SelectTriggerProps extends AriaSelectProps {
  icon?: React.ReactNode;
  text?: React.ReactNode;
  variant?: Variant;
  shortcut?: ShortcutDefinition;
  tooltipTitle?: string;
}

export function SelectTrigger({
  icon,
  variant = "tertiary/small",
  text,
  shortcut,
  tooltipTitle,
  disabled,
  ...props
}: SelectTriggerProps) {
  const ref = React.useRef<HTMLButtonElement>(null);
  useShortcutKeys({
    shortcut: shortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ref.current) {
        ref.current.click();
      }
    },
    disabled,
  });

  const showTooltip = tooltipTitle || shortcut;
  const variantClasses = variants[variant];

  return (
    <Ariakit.TooltipProvider timeout={200}>
      <Ariakit.TooltipAnchor
        className="button"
        render={
          <Ariakit.Select
            {...props}
            className={cn(
              "group flex items-center gap-1 outline-offset-0 focus-within:outline-none focus-within:ring-1 disabled:cursor-not-allowed disabled:opacity-50",
              variantClasses.button,
              props.className
            )}
            ref={ref}
          ></Ariakit.Select>
        }
      >
        {icon}
        <div className="truncate">
          {text || (
            <SelectValue>
              {(value) => (
                <>{typeof value === "object" && Array.isArray(value) ? value.join(", ") : value}</>
              )}
            </SelectValue>
          )}
        </div>
      </Ariakit.TooltipAnchor>
      {showTooltip && (
        <Ariakit.Tooltip
          disabled={shortcut === undefined}
          className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright px-2 py-1.5 text-xs"
        >
          <div className="flex items-center gap-2">
            <span>{tooltipTitle ?? "Open menu"}</span>
            {shortcut && (
              <ShortcutKey
                className={cn("size-4 flex-none")}
                shortcut={shortcut}
                variant={"small"}
              />
            )}
          </div>
        </Ariakit.Tooltip>
      )}
    </Ariakit.TooltipProvider>
  );
}

function SelectGroupedRenderer<TItem>({
  items,
  children,
  enableItemShortcuts,
}: {
  items: Section<TItem>[];
  children: (
    items: ItemFromSection<TItem>[],
    meta: {
      shortcutsEnabled?: boolean;
      section?: { title?: string; startIndex: number; count: number };
    }
  ) => React.ReactNode;
  enableItemShortcuts: boolean;
}) {
  let count = 0;
  return (
    <>
      {items.map((section, index) => {
        const previousItem = items.at(index - 1);
        count += previousItem ? previousItem.items.length : 0;
        return (
          <Fragment key={index}>
            {children(section.items as ItemFromSection<TItem>[], {
              shortcutsEnabled: enableItemShortcuts,
              section: {
                title: section.title,
                startIndex: count - 1,
                count: section.items.length,
              },
            })}
          </Fragment>
        );
      })}
    </>
  );
}

export interface SelectTabListProps extends Ariakit.TabListProps {}

export function SelectTabList(props: SelectTabListProps) {
  return <Ariakit.TabList {...props} />;
}

export interface SelectTabProps extends Ariakit.TabProps {}

export function SelectTab(props: SelectTabProps) {
  return (
    <Ariakit.Tab
      {...props}
      render={<Ariakit.Role.div render={props.render} />}
      className={cn("", props.className)}
    />
  );
}

export interface SelectTabPanelProps extends Ariakit.TabPanelProps {}

export function SelectTabPanel(props: SelectTabPanelProps) {
  const tab = Ariakit.useTabContext()!;
  const tabId = tab.useState((state) => props.tabId || state.selectedId);
  return (
    <Ariakit.TabPanel
      key={tabId}
      tabId={tabId}
      unmountOnHide
      {...props}
      className={cn(
        "popup-layer popup-cover flex flex-col pt-[calc(var(--padding)*2)]",
        props.className
      )}
    />
  );
}

interface SelectListProps extends Omit<Ariakit.SelectListProps, "store"> {}

function SelectList(props: SelectListProps) {
  const combobox = Ariakit.useComboboxContext();
  const Component = combobox ? Ariakit.ComboboxList : Ariakit.SelectList;

  return (
    <Component
      {...props}
      className={cn(
        "overflow-y-auto overscroll-contain outline-none scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600",
        props.className
      )}
    />
  );
}

export interface SelectItemProps extends Ariakit.SelectItemProps {
  icon?: React.ReactNode;
  shortcut?: ShortcutDefinition;
}

const selectItemClasses =
  "group cursor-pointer px-1 pt-1 text-xs text-text-dimmed outline-none last:pb-1";

export function SelectItem({
  icon = <Ariakit.SelectItemCheck className="size-8 flex-none text-white" />,
  shortcut,
  ...props
}: SelectItemProps) {
  const combobox = Ariakit.useComboboxContext();
  const render = combobox ? <Ariakit.ComboboxItem render={props.render} /> : undefined;
  const ref = React.useRef<HTMLDivElement>(null);

  useShortcutKeys({
    shortcut: shortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ref.current) {
        ref.current.click();
      }
    },
    disabled: props.disabled,
    enabledOnInputElements: true,
  });

  return (
    <Ariakit.SelectItem
      {...props}
      render={render}
      blurOnHoverEnd={false}
      className={cn(
        selectItemClasses,
        "[--padding-block:0.5rem] sm:[--padding-block:0.25rem]",
        props.className
      )}
      ref={ref}
    >
      <div className="flex h-7 w-full items-center gap-1 rounded-sm px-2 group-data-[active-item=true]:bg-tertiary">
        <div className="grow truncate">{props.children || props.value}</div>
        {icon}
        {shortcut && (
          <ShortcutKey className={cn("size-4 flex-none")} shortcut={shortcut} variant={"small"} />
        )}
      </div>
    </Ariakit.SelectItem>
  );
}

export interface SelectLinkItemProps extends Ariakit.SelectItemProps {
  icon?: React.ReactNode;
  shortcut?: ShortcutDefinition;
  to: string;
}

export function SelectLinkItem({
  icon = <Ariakit.SelectItemCheck className="size-8 flex-none text-white" />,
  shortcut,
  to,
  ...props
}: SelectLinkItemProps) {
  const combobox = Ariakit.useComboboxContext();
  const link = (
    <Link to={to} className={cn("block", selectItemClasses, props.className)}>
      <div className="flex h-7 w-full items-center gap-1 rounded-sm px-2 group-data-[active-item=true]:bg-tertiary">
        {icon}
        <div className="grow truncate">{props.children || props.value}</div>
        {shortcut && (
          <ShortcutKey className={cn("size-4 flex-none")} shortcut={shortcut} variant={"small"} />
        )}
      </div>
    </Link>
  );
  const render = combobox ? <Ariakit.ComboboxItem render={link} /> : link;
  const ref = React.useRef<HTMLDivElement>(null);

  useShortcutKeys({
    shortcut: shortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ref.current) {
        ref.current.click();
      }
    },
    disabled: props.disabled,
    enabledOnInputElements: true,
  });

  return (
    <Ariakit.SelectItem
      {...props}
      render={render}
      blurOnHoverEnd={false}
      className={cn(selectItemClasses, props.className)}
      ref={ref}
    />
  );
}

export function shortcutFromIndex(
  index: number,
  meta: {
    shortcutsEnabled?: boolean;
    section?: { startIndex: number };
  }
): ShortcutDefinition | undefined {
  if (!meta.shortcutsEnabled) return;

  let adjustedIndex = index + (meta.section?.startIndex ?? 0);

  if (adjustedIndex > 9) return;
  if (adjustedIndex === 9) {
    adjustedIndex = -1;
  }

  return { key: String(adjustedIndex + 1) };
}

export interface SelectSeparatorProps extends React.ComponentProps<"div"> {}

export function SelectSeparator(props: SelectSeparatorProps) {
  return <div {...props} className={cn("h-px bg-charcoal-700", props.className)} />;
}

export interface SelectGroupProps extends Ariakit.SelectGroupProps {}

export function SelectGroup(props: SelectGroupProps) {
  return <Ariakit.SelectGroup {...props} />;
}

export interface SelectGroupLabelProps extends Ariakit.SelectGroupLabelProps {}

export function SelectGroupLabel(props: SelectGroupLabelProps) {
  return (
    <Ariakit.SelectGroupLabel
      {...props}
      className={cn(
        "flex h-[1.375rem] items-center border-b border-charcoal-700 bg-charcoal-750 px-2.5 text-xxs uppercase text-text-bright",
        props.className
      )}
    />
  );
}

export interface SelectHeadingProps extends Ariakit.SelectHeadingProps {}

export function SelectHeading({ render, ...props }: SelectHeadingProps) {
  return (
    <div className="flex h-[1.375rem] flex-none cursor-default items-center gap-2 border-b border-charcoal-700 bg-charcoal-750 px-2.5 text-xxs uppercase text-text-bright">
      <Ariakit.SelectHeading render={<>{render}</>} />
    </div>
  );
}
