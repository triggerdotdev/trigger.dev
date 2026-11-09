import { RadioGroup } from "@headlessui/react";
import { animate, motion, useMotionValue } from "framer-motion";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "~/utils/cn";
import { SimpleTooltip } from "./Tooltip";

const sizes = {
  small: {
    control: "h-6",
    option: "px-2 text-xs",
    container: "gap-x-0.5",
  },
  medium: {
    control: "h-10",
    option: "px-3 py-[0.13rem] text-sm",
    container: "p-1 gap-x-0.5",
  },
};

const theme = {
  primary: {
    base: "bg-background-raised",
    active: "text-text-bright hover:bg-background-hover/50",
    inactive: "text-text-dimmed transition hover:text-text-bright",
    selected: "absolute inset-0 rounded-[2px] outline-solid outline-3 outline-primary",
  },
  secondary: {
    base: "bg-segmented-track",
    active: "text-text-bright",
    inactive: "text-text-dimmed transition hover:text-text-bright",
    selected:
      "absolute inset-0 rounded bg-white border border-grid-bright dark:bg-background-raised dark:border-border-bright",
  },
};

type Size = keyof typeof sizes;
type Theme = keyof typeof theme;

type VariantStyle = {
  base: string;
  active: string;
  inactive: string;
  option: string;
  container: string;
  selected: string;
};

function createVariant(sizeName: Size, themeName: Theme): VariantStyle {
  return {
    base: cn(sizes[sizeName].control, theme[themeName].base),
    active: theme[themeName].active,
    inactive: theme[themeName].inactive,
    option: sizes[sizeName].option,
    container: sizes[sizeName].container,
    selected: theme[themeName].selected,
  };
}

const variants = {
  "primary/small": createVariant("small", "primary"),
  "primary/medium": createVariant("medium", "primary"),
  "secondary/small": createVariant("small", "secondary"),
  "secondary/medium": createVariant("medium", "secondary"),
} as const;

type VariantType = keyof typeof variants;

type Options = {
  label: ReactNode;
  value: string;
  disabled?: boolean;
  /** Shown on hover, e.g. why a disabled option can't be picked. */
  tooltip?: ReactNode;
};

type SegmentedControlProps = {
  name: string;
  value?: string;
  defaultValue?: string;
  options: Options[];
  variant?: VariantType;
  fullWidth?: boolean;
  onChange?: (value: string) => void;
  /** Override the control's outer styling (e.g. a height that matches an adjacent input). */
  className?: string;
};

export default function SegmentedControl({
  name,
  value,
  defaultValue,
  options,
  variant = "secondary/medium",
  fullWidth,
  onChange,
  className,
}: SegmentedControlProps) {
  const variantStyle = variants[variant];
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? options[0].value);
  const selected = value ?? uncontrolledValue;
  const optionsRef = useRef<HTMLDivElement>(null);
  const previousSelected = useRef(selected);
  // The active pill's left and right insets from the selected option. A switch starts them at the
  // previous option's edges and springs them to 0, so the pill only travels along the control.
  const pillLeft = useMotionValue(0);
  const pillRight = useMotionValue(0);

  useLayoutEffect(() => {
    const previous = previousSelected.current;
    previousSelected.current = selected;
    if (previous === selected) return;

    const segments = [
      ...(optionsRef.current?.querySelectorAll<HTMLElement>("[data-segment-value]") ?? []),
    ];
    const from = segments.find((segment) => segment.dataset.segmentValue === previous);
    const to = segments.find((segment) => segment.dataset.segmentValue === selected);
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (!from || !to || !first || !last) {
      // Nothing to animate from, so draw the pill on the selected option.
      pillLeft.set(0);
      pillRight.set(0);
      return;
    }

    // Everything is measured in the same frame, so a page shift cancels out.
    const fromBox = from.getBoundingClientRect();
    const toBox = to.getBoundingClientRect();
    // The spring overshoots a little; these insets keep the pill within the outer options.
    const minLeft = first.getBoundingClientRect().left - toBox.left;
    const minRight = toBox.right - last.getBoundingClientRect().right;
    // Start from where the pill is drawn now, which is mid-flight after a quick second click.
    const startLeft = fromBox.left + pillLeft.get() - toBox.left;
    const startRight = toBox.right - (fromBox.right - pillRight.get());
    pillLeft.set(startLeft);
    pillRight.set(startRight);

    // One spring drives both edges, so the pill moves and resizes together.
    const animation = animate(0, 1, {
      duration: 0.4,
      type: "spring",
      onUpdate: (progress) => {
        pillLeft.set(Math.max(minLeft, startLeft * (1 - progress)));
        pillRight.set(Math.max(minRight, startRight * (1 - progress)));
      },
    });
    return () => animation.stop();
  }, [selected, pillLeft, pillRight]);

  return (
    <div
      className={cn(
        "flex rounded text-text-bright",
        variantStyle.base,
        fullWidth ? "w-full" : "w-fit",
        className
      )}
    >
      <RadioGroup
        value={value}
        defaultValue={defaultValue ?? options[0].value}
        name={name}
        onChange={(c: string) => {
          setUncontrolledValue(c);
          if (onChange) {
            onChange(c);
          }
        }}
        className="w-full"
      >
        <div
          ref={optionsRef}
          className={cn("flex h-full w-full items-center justify-between", variantStyle.container)}
        >
          {options.map((option) => (
            <RadioGroup.Option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              data-segment-value={option.value}
              className={({ checked }) =>
                cn(
                  "relative flex h-full grow cursor-pointer text-center font-normal focus-custom",
                  checked ? variantStyle.active : variantStyle.inactive,
                  option.disabled && "cursor-not-allowed opacity-50"
                )
              }
            >
              {({ checked }) => (
                <div
                  className={cn(
                    "relative flex h-full w-full items-center justify-between",
                    variantStyle.option
                  )}
                >
                  {option.tooltip ? (
                    <SimpleTooltip
                      asChild
                      button={
                        <div className="z-10 flex h-full w-full items-center justify-center">
                          <RadioGroup.Label as="p">{option.label}</RadioGroup.Label>
                        </div>
                      }
                      content={option.tooltip}
                      side="top"
                    />
                  ) : (
                    <div className="z-10 flex h-full w-full items-center justify-center">
                      <RadioGroup.Label as="p">{option.label}</RadioGroup.Label>
                    </div>
                  )}
                  {checked && (
                    <motion.div
                      style={{ left: pillLeft, right: pillRight }}
                      className={variantStyle.selected}
                    />
                  )}
                </div>
              )}
            </RadioGroup.Option>
          ))}
        </div>
      </RadioGroup>
    </div>
  );
}
