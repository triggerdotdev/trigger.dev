import { hasIcon } from "@trigger.dev/companyicons";
import { iconNames as namedIcons } from "~/components/primitives/NamedIcon";
import { tablerIcons } from "~/utils/tablerIcons";

export const isValidIcon = (icon?: string): boolean => {
  if (!icon) {
    return false;
  }
  return namedIcons.includes(icon) || hasIcon(icon) || tablerIcons.has(icon);
};
