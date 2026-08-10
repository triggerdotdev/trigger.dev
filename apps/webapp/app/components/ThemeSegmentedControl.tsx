import SegmentedControl from "~/components/primitives/SegmentedControl";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { CLASSIC_OPTION, THEME_OPTIONS, type ThemeOption } from "~/components/themeOptions";
import { type ThemePreference } from "~/utils/themePreference";

/**
 * Icon-only segmented control for picking a theme. Every segment is labelled by
 * a tooltip and screen-reader text.
 *
 * `name` must be unique per mounted instance: the underlying control animates
 * its selection with a shared `layoutId` derived from it, so two instances with
 * the same name would fight over one indicator.
 */
export function ThemeSegmentedControl({
  name,
  value,
  onChange,
  includeClassic = false,
}: {
  name: string;
  /** A value outside the offered segments (e.g. `classic` when it isn't
   *  included) simply leaves the control with nothing selected. */
  value: ThemePreference;
  onChange: (theme: ThemePreference) => void;
  includeClassic?: boolean;
}) {
  const segments = includeClassic ? [...THEME_OPTIONS, CLASSIC_OPTION] : THEME_OPTIONS;

  return (
    <SegmentedControl
      name={name}
      value={value}
      variant="secondary/small"
      onChange={(theme) => onChange(theme as ThemePreference)}
      options={segments.map((segment) => ({
        value: segment.value,
        label: <ThemeSegmentLabel segment={segment} />,
      }))}
    />
  );
}

function ThemeSegmentLabel({ segment }: { segment: ThemeOption }) {
  return (
    <SimpleTooltip
      asChild
      button={
        // -mx-0.5 tightens the icon segment toward a square button.
        <span className="-mx-0.5 flex items-center justify-center">
          <segment.icon className="size-4" />
          <span className="sr-only">{segment.label}</span>
        </span>
      }
      content={segment.label}
      className="px-2 py-1.5 text-xs"
      sideOffset={6}
      disableHoverableContent
    />
  );
}
