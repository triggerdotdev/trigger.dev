import * as Ariakit from "@ariakit/react";
import { SelectValue } from "@ariakit/react-core/select/select-value";
import * as React from "react";
import { cn } from "~/utils/cn";

export interface SelectProps<TValue extends string | string[], TItem> extends Ariakit.SelectProps {
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
  filter?: { items: TItem[]; fn: (item: TItem, search: string) => boolean };
}

export function Select<TValue extends string | string[], TItem = any>({
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
  filter,
  ...props
}: SelectProps<TValue, TItem>) {
  const searchable = filter !== undefined;

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
        className={cn("focusable clickable button button-default", props.className)}
      >
        {icon}
        <div className="truncate">{text || <SelectValue />}</div>
        <Ariakit.SelectArrow />
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
            <Ariakit.SelectDismiss className="focusable clickable rounded-item button button-secondary button-flat button-icon button-small opacity-70" />
          </div>
        )}
        {searchable && (
          <Ariakit.Combobox
            autoSelect
            render={<input placeholder={heading ?? "Filter options"} />}
            className="focusable combobox input rounded-item -mb-1 h-10 w-full px-[13px]"
          />
        )}
        <Ariakit.TabProvider
          selectedId={tab}
          setSelectedId={setTab}
          defaultSelectedId={defaultTab}
          selectOnMove={selectTabOnMove}
        >
          <div className="tabs-border popup-cover flex flex-col">{children}</div>
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
            // onSearch?.(value);
          });
        }}
      >
        <SelectList>{select}</SelectList>
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
      className={cn("clickable tab tab-default", props.className)}
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
        "option clickable [--padding-block:0.5rem] sm:[--padding-block:0.25rem]",
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
