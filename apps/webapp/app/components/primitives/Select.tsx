import * as Ariakit from "@ariakit/react";
import { type SelectProps as AriaSelectProps } from "@ariakit/react";
import { SelectValue } from "@ariakit/react-core/select/select-value";
import { Link } from "@remix-run/react";
import * as React from "react";
import { Fragment, useMemo, useState } from "react";
import { type ShortcutDefinition, useShortcutKeys } from "~/hooks/useShortcutKeys";
import { cn } from "~/utils/cn";
import { ShortcutKey } from "./ShortcutKey";
import { ChevronDown } from "lucide-react";
import { type MatchSorterOptions, matchSorter } from "match-sorter";

const sizes = {
  small: {
    button: "h-6 rounded text-xs px-2 ",
  },
  medium: {
    button: "h-8 rounded px-3 text-sm",
  },
};

const style = {
  tertiary: {
    button:
      "bg-tertiary focus-custom border border-tertiary hover:text-text-bright hover:border-charcoal-600",
  },
  minimal: {
    button:
      "bg-transparent focus-custom hover:bg-tertiary disabled:bg-transparent disabled:pointer-events-none",
  },
};

const variants = {
  "tertiary/small": {
    button: cn(sizes.small.button, style.tertiary.button),
  },
  "tertiary/medium": {
    button: cn(sizes.medium.button, style.tertiary.button),
  },
  "minimal/small": {
    button: cn(sizes.small.button, style.minimal.button),
  },
  "minimal/medium": {
    button: cn(sizes.medium.button, style.minimal.button),
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
  text?: React.ReactNode | ((value: TValue) => React.ReactNode);
  placeholder?: React.ReactNode;
  value?: Ariakit.SelectProviderProps<TValue>["value"];
  setValue?: Ariakit.SelectProviderProps<TValue>["setValue"];
  defaultValue?: Ariakit.SelectProviderProps<TValue>["defaultValue"];
  label?: string | Ariakit.SelectLabelProps["render"];
  heading?: string;
  showHeading?: boolean;
  items?: TItem[] | Section<TItem>[];
  empty?: React.ReactNode;
  filter?:
    | boolean
    | MatchSorterOptions<TItem>
    | ((item: ItemFromSection<TItem>, search: string, title?: string) => boolean);
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
  clearSearchOnSelection?: boolean;
  dropdownIcon?: boolean | React.ReactNode;
}

export function Select<TValue extends string | string[], TItem>({
  children,
  icon,
  text,
  placeholder,
  value,
  setValue,
  defaultValue,
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
  clearSearchOnSelection = true,
  dropdownIcon,
  ...props
}: SelectProps<TValue, TItem>) {
  const [searchValue, setSearchValue] = useState("");
  const searchable = items !== undefined && filter !== undefined;

  const matches = useMemo(() => {
    if (!items) return [];
    if (!searchValue || !filter) return items;

    if (typeof filter === "function") {
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
    }

    if (typeof filter === "boolean" && filter) {
      if (isSection(items)) {
        return items
          .map((section) => ({
            ...section,
            items: matchSorter(section.items, searchValue),
          }))
          .filter((section) => section.items.length > 0);
      }

      return matchSorter(items, searchValue);
    }

    if (isSection(items)) {
      return items
        .map((section) => ({
          ...section,
          items: matchSorter(section.items, searchValue, filter),
        }))
        .filter((section) => section.items.length > 0);
    }

    return matchSorter(items, searchValue, filter);
  }, [searchValue, items]);

  const enableItemShortcuts = allowItemShortcuts && matches.length === items?.length;

  const select = (
    <SelectProvider
      open={open}
      setOpen={setOpen}
      virtualFocus={searchable}
      value={value}
      setValue={(v) => {
        if (clearSearchOnSelection) {
          setSearchValue("");
        }

        if (setValue) {
          setValue(v as any);
        }
      }}
      defaultValue={defaultValue}
    >
      {label && <SelectLabel render={typeof label === "string" ? <div>{label}</div> : label} />}
      <SelectTrigger
        icon={icon}
        variant={variant}
        text={text}
        placeholder={placeholder}
        shortcut={shortcut}
        tooltipTitle={heading}
        disabled={disabled}
        dropdownIcon={dropdownIcon}
        {...props}
      />
      <SelectPopover>
        {!searchable && showHeading && heading && <SelectHeading render={<>{heading}</>} />}
        {searchable && <ComboBox placeholder={heading} shortcut={shortcut} value={searchValue} />}

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
      </SelectPopover>
    </SelectProvider>
  );

  if (searchable) {
    return (
      <ComboboxProvider
        resetValueOnHide
        setValue={(value) => {
          React.startTransition(() => {
            setSearchValue(value);
          });
        }}
      >
        {select}
      </ComboboxProvider>
    );
  }

  return select;
}

export interface SelectTriggerProps<TValue = any> extends AriaSelectProps {
  icon?: React.ReactNode;
  text?: React.ReactNode | ((value: TValue) => React.ReactNode);
  placeholder?: React.ReactNode;
  variant?: Variant;
  shortcut?: ShortcutDefinition;
  tooltipTitle?: string;
  dropdownIcon?: boolean | React.ReactNode;
}

export function SelectTrigger({
  icon,
  variant = "tertiary/small",
  text,
  shortcut,
  tooltipTitle,
  disabled,
  placeholder,
  dropdownIcon = false,
  children,
  className,
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

  let content: React.ReactNode = "";
  if (children) {
    content = children;
  } else if (text !== undefined) {
    if (typeof text === "function") {
      content = <SelectValue>{(value) => <>{text(value) ?? placeholder}</>}</SelectValue>;
    } else {
      content = text;
    }
  } else {
    content = (
      <SelectValue>
        {(value) => (
          <>
            {typeof value === "string"
              ? value ?? placeholder
              : value.length === 0
              ? placeholder
              : value.join(", ")}
          </>
        )}
      </SelectValue>
    );
  }

  return (
    <Ariakit.TooltipProvider timeout={200}>
      <Ariakit.TooltipAnchor
        className="button"
        render={
          <Ariakit.Select
            className={cn(
              "group flex items-center gap-1 focus-custom disabled:cursor-not-allowed disabled:opacity-50",
              variantClasses.button,
              className
            )}
            ref={ref}
            {...props}
          />
        }
      >
        <div className="flex grow items-center gap-0.5">
          {icon && <div className="-ml-1 flex-none">{icon}</div>}
          <div className="truncate">{content}</div>
        </div>
        {dropdownIcon === true ? (
          <ChevronDown
            className={cn(
              "size-4 flex-none text-text-dimmed transition group-hover:text-text-bright group-focus:text-text-bright"
            )}
          />
        ) : !dropdownIcon ? null : (
          dropdownIcon
        )}
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

export interface SelectProviderProps<TValue extends string | string[]>
  extends Ariakit.SelectProviderProps<TValue> {}
export function SelectProvider<TValue extends string | string[]>(
  props: SelectProviderProps<TValue>
) {
  return <Ariakit.SelectProvider {...props} />;
}

export interface ComboboxProviderProps extends Ariakit.ComboboxProviderProps {}
export function ComboboxProvider(props: ComboboxProviderProps) {
  return <Ariakit.ComboboxProvider {...props} />;
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

export interface SelectListProps extends Omit<Ariakit.SelectListProps, "store"> {}
export function SelectList(props: SelectListProps) {
  const combobox = Ariakit.useComboboxContext();
  const Component = combobox ? Ariakit.ComboboxList : Ariakit.SelectList;

  return (
    <Component
      {...props}
      className={cn(
        "overflow-y-auto overscroll-contain scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 focus-custom",
        props.className
      )}
    />
  );
}

export interface SelectItemProps extends Ariakit.SelectItemProps {
  icon?: React.ReactNode;
  checkIcon?: React.ReactNode;
  shortcut?: ShortcutDefinition;
}

const selectItemClasses =
  "group cursor-pointer px-1 pt-1 text-2sm text-text-dimmed focus-custom last:pb-1";

export function SelectItem({
  icon,
  checkIcon = <Ariakit.SelectItemCheck className="size-8 flex-none text-text-bright" />,
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
      <div className="flex h-8 w-full items-center gap-1 rounded-sm px-2 group-data-[active-item=true]:bg-tertiary">
        {icon}
        <div className="grow truncate">{props.children || props.value}</div>
        {checkIcon}
        {shortcut && (
          <ShortcutKey
            className={cn("size-4 flex-none transition duration-0 group-hover:border-charcoal-600")}
            shortcut={shortcut}
            variant={"small"}
          />
        )}
      </div>
    </Ariakit.SelectItem>
  );
}

export interface SelectLinkItemProps extends Ariakit.SelectItemProps {
  icon?: React.ReactNode;
  checkIcon?: React.ReactNode;
  shortcut?: ShortcutDefinition;
  to: string;
}

export function SelectLinkItem({
  checkIcon = <Ariakit.SelectItemCheck className="size-8 flex-none text-white" />,
  to,
  ...props
}: SelectLinkItemProps) {
  const render = <Link to={to} className={cn("block", selectItemClasses, props.className)} />;

  return (
    <SelectItem
      {...props}
      render={render}
      blurOnHoverEnd={false}
      className={cn(selectItemClasses, props.className)}
    />
  );
}

export interface SelectButtonItemProps extends Omit<Ariakit.SelectItemProps, "onClick"> {
  icon?: React.ReactNode;
  checkIcon?: React.ReactNode;
  shortcut?: ShortcutDefinition;
  onClick: React.ComponentProps<"button">["onClick"];
}

export function SelectButtonItem({
  checkIcon = <Ariakit.SelectItemCheck className="size-8 flex-none text-white" />,
  onClick,
  ...props
}: SelectButtonItemProps) {
  const render = (
    <button
      onClick={onClick}
      className={cn("block w-full text-left", selectItemClasses, props.className)}
    />
  );

  return (
    <SelectItem
      {...props}
      render={render}
      blurOnHoverEnd={false}
      className={cn(selectItemClasses, props.className)}
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

export interface SelectPopoverProps extends Ariakit.SelectPopoverProps {}
export function SelectPopover({
  gutter = 5,
  shift = 0,
  unmountOnHide = true,
  className,
  ...props
}: SelectPopoverProps) {
  return (
    <Ariakit.SelectPopover
      gutter={gutter}
      shift={shift}
      unmountOnHide={unmountOnHide}
      className={cn(
        "z-50 flex flex-col overflow-clip rounded border border-charcoal-700 bg-background-bright shadow-md outline-none animate-in fade-in-40",
        "min-w-[max(180px,var(--popover-anchor-width))]",
        "max-w-[min(480px,var(--popover-available-width))]",
        "max-h-[min(600px,var(--popover-available-height))]",
        "origin-[var(--popover-transform-origin)]",
        className
      )}
      {...props}
    />
  );
}

export interface SelectLabelProps extends Ariakit.SelectLabelProps {}
//currently unstyled
export function SelectLabel(props: SelectLabelProps) {
  return <Ariakit.SelectLabel {...props} />;
}

export interface ComboBoxProps extends Ariakit.ComboboxProps {
  shortcut?: ShortcutDefinition;
}

export function ComboBox({
  autoSelect = true,
  placeholder = "Filter options",
  shortcut,
  ...props
}: ComboBoxProps) {
  return (
    <div className="flex h-9 w-full flex-none items-center border-b border-grid-dimmed bg-transparent px-3 text-xs text-text-dimmed outline-none">
      <Ariakit.Combobox
        autoSelect={autoSelect}
        render={<input placeholder={placeholder} />}
        className="flex-1 bg-transparent text-xs text-text-dimmed outline-none"
        {...props}
      />
      {shortcut && (
        <ShortcutKey className={cn("size-4 flex-none")} shortcut={shortcut} variant={"small"} />
      )}
    </div>
  );
}
