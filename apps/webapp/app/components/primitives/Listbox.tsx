import * as Ariakit from "@ariakit/react";
import { SelectValue } from "@ariakit/react-core/select/select-value";
import { ChevronDown } from "lucide-react";
import * as React from "react";
import { useMemo, useState } from "react";
import { T } from "vitest/dist/reporters-P7C2ytIv.js";
import { cn } from "~/utils/cn";

const sizes = {
  small: {
    button:
      "h-6 rounded text-xs bg-tertiary border border-tertiary hover:text-text-bright hover:border-charcoal-600 pr-2 pl-1.5",
  },
  medium: {
    button: "h-8",
  },
};

const variants = {
  "tertiary/small": {
    button: cn(sizes.small.button, ""),
  },
};

type Variant = keyof typeof variants;

type Section<TItem> = {
  title: string;
  items: TItem[];
};

function isSection<TItem>(data: TItem[] | Section<TItem>[]): data is Section<TItem>[] {
  const firstItem = data[0];
  return (
    (firstItem as Section<TItem>).title !== undefined &&
    (firstItem as Section<TItem>).items !== undefined &&
    Array.isArray((firstItem as Section<TItem>).items)
  );
}

type TItemFromSection<TItem> = TItem extends Section<infer U> ? U : TItem;

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
  items: TItem[] | Section<TItem>[];
  empty?: React.ReactNode;
  filter?: (item: TItemFromSection<TItem>, search: string) => boolean;
  children: (items: TItemFromSection<TItem>[], title?: string) => React.ReactNode;
  variant?: Variant;
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
  items,
  filter,
  empty = "No items",
  variant = "tertiary/small",
  ...props
}: SelectProps<TValue, TItem>) {
  const [searchValue, setSearchValue] = useState("");
  const searchable = filter !== undefined;

  const matches = useMemo(() => {
    if (!items) return [];
    if (!searchValue || !filter) return items;

    if (isSection(items)) {
      return items.map((section) => ({
        ...section,
        items: section.items.filter((item) => filter(item as TItemFromSection<TItem>, searchValue)),
      }));
    }

    return items.filter((item) => filter(item as TItemFromSection<TItem>, searchValue));
  }, [searchValue, items]);

  const variantClasses = variants[variant];

  const select = (
    <Ariakit.SelectProvider
      virtualFocus={searchable}
      value={value}
      setValue={setValue}
      defaultValue={defaultValue}
    >
      {label && (
        <Ariakit.SelectLabel render={typeof label === "string" ? <div>{label}</div> : label} />
      )}
      <Ariakit.Select
        {...props}
        className={cn(
          "group flex items-center gap-2 outline-offset-0 outline-secondary disabled:cursor-not-allowed disabled:opacity-50",
          variantClasses.button,
          props.className
        )}
      >
        {icon}
        <div className="truncate">{text || <SelectValue />}</div>
        <Ariakit.SelectArrow
          className={cn(
            "size-5 text-text-dimmed transition group-hover:text-text-bright group-focus:text-text-bright"
          )}
        />
      </Ariakit.Select>
      <Ariakit.SelectPopover
        gutter={5}
        shift={-4}
        unmountOnHide
        className="popup elevation-1 popover popover-enter flex flex-col gap-[9px] overflow-clip"
      >
        {!searchable && heading && (
          <div className="grid grid-cols-[auto_max-content] items-center gap-2 ps-[13px]">
            <Ariakit.SelectHeading
              className="cursor-default font-medium opacity-80"
              render={<>{heading}</>}
            />
            <Ariakit.SelectDismiss className="rounded-item button-secondary button-flat button-icon button-small opacity-70 outline-offset-0 outline-secondary" />
          </div>
        )}
        {searchable && (
          <Ariakit.Combobox
            autoSelect
            render={<input placeholder={heading ?? "Filter options"} />}
            className="combobox input rounded-item -mb-1 h-10 w-full px-[13px] outline-offset-0 outline-secondary"
          />
        )}
        <Ariakit.TabProvider
          selectedId={tab}
          setSelectedId={setTab}
          defaultSelectedId={defaultTab}
          selectOnMove={selectTabOnMove}
        >
          <div className="tabs-border popup-cover flex flex-col">
            <SelectList>
              {matches.length > 0
                ? isSection(matches)
                  ? matches.map((section) =>
                      children(section.items as TItemFromSection<TItem>[], section.title)
                    )
                  : children(matches as TItemFromSection<TItem>[])
                : empty}
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
      className={cn("tab tab-default", props.className)}
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
        "tab-panel popup-cover overflow-auto overscroll-contain outline-none",
        props.className
      )}
    />
  );
}

export interface SelectItemProps extends Ariakit.SelectItemProps {
  icon?: React.ReactNode;
}

export function SelectItem({ icon = <Ariakit.SelectItemCheck />, ...props }: SelectItemProps) {
  const combobox = Ariakit.useComboboxContext();
  const render = combobox ? <Ariakit.ComboboxItem render={props.render} /> : undefined;
  return (
    <Ariakit.SelectItem
      {...props}
      render={render}
      blurOnHoverEnd={false}
      className={cn(
        "option [--padding-block:0.5rem] sm:[--padding-block:0.25rem]",
        props.className
      )}
    >
      {icon}
      <div className="truncate">{props.children || props.value}</div>
    </Ariakit.SelectItem>
  );
}

export interface SelectSeparatorProps extends React.ComponentProps<"div"> {}

export function SelectSeparator(props: SelectSeparatorProps) {
  return (
    <div
      {...props}
      className={cn("popup-cover my-[--padding] h-px bg-[--border] p-0", props.className)}
    />
  );
}

export interface SelectGroupProps extends Ariakit.SelectGroupProps {}

export function SelectGroup(props: SelectGroupProps) {
  return <Ariakit.SelectGroup {...props} />;
}

export interface SelectGroupLabelProps extends Ariakit.SelectGroupLabelProps {}

export function SelectGroupLabel(props: SelectGroupLabelProps) {
  return <Ariakit.SelectGroupLabel {...props} />;
}
