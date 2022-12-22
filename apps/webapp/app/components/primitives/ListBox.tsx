import { Listbox } from "@headlessui/react";
import { ChevronUpDownIcon } from "@heroicons/react/24/outline";
import classNames from "classnames";

type LabelProps = Parameters<typeof Listbox.Label>[0];
const labelClassName = "block text-sm font-medium text-gray-700";
function Label(props: LabelProps) {
  return (
    <Listbox className={classNames(labelClassName, props.className)} {...props}>
      {props.children}
    </Listbox>
  );
}

type ButtonProps = Parameters<typeof Listbox.Button>[0] & {
  children: React.ReactNode;
};

const buttonClassName =
  "relative w-full cursor-default rounded-md border border-slate-600 bg-slate-800 py-2 pl-3 pr-10 text-left shadow-md focus:border-blue-700 focus:outline-none focus:ring-1 focus:ring-blue-700 sm:text-sm";
function Button({ children, ...props }: ButtonProps) {
  return (
    <Listbox.Button
      className={classNames(buttonClassName, props.className)}
      {...props}
    >
      <span className="block truncate">{children}</span>
      <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
        <ChevronUpDownIcon
          className="h-5 w-5 text-gray-400"
          aria-hidden="true"
        />
      </span>
    </Listbox.Button>
  );
}

type OptionsProps = Parameters<typeof Listbox.Options>[0];
const optionsClassName =
  "absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-600 bg-slate-800 text-base shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none sm:text-sm";
function Options(props: OptionsProps) {
  return (
    <Listbox.Options
      className={classNames(optionsClassName, props.className)}
      {...props}
    >
      {props.children}
    </Listbox.Options>
  );
}

type OptionProps = Parameters<typeof Listbox.Option>[0];
const optionClassName = "relative cursor-default select-none py-2 pl-3 pr-9";
const activeOptionClassName = "text-slate-300 bg-slate-900";
const inactiveOptionClassName = "text-slate-300";
function Option(props: OptionProps) {
  return (
    <Listbox.Option
      className={({ active }: { active: boolean }) =>
        classNames(
          active ? activeOptionClassName : inactiveOptionClassName,
          optionClassName,
          props.className
        )
      }
      {...props}
    />
  );
}

export const StyledListBox = { Label, Button, Options, Option };
