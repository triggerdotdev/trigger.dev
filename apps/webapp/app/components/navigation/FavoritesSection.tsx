import { EllipsisHorizontalIcon } from "@heroicons/react/20/solid";
import { useLocation, useNavigation } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { CrossIcon } from "~/assets/icons/CrossIcon";
import { RenameIcon } from "~/assets/icons/RenameIcon";
import { useIsImpersonating } from "~/hooks/useOrganizations";
import { type FavoritePage } from "~/services/dashboardPreferences.server";
import { cn } from "~/utils/cn";
import { Icon, type RenderIcon } from "../primitives/Icon";
import {
  Popover,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverMenuItem,
} from "../primitives/Popover";
import {
  favoriteLinkTo,
  favoritePageActiveColor,
  favoritePageIcon,
  favoritePageIconClassName,
  isFavoriteActive,
} from "./favoritePages";
import { SideMenuItem } from "./SideMenuItem";
import { SIDE_MENU_POPOVER_ITEM_ICON, SIDE_MENU_POPOVER_ITEM_LABEL } from "./sideMenuTypes";

/**
 * A favorited page in the side menu. Renders like a normal menu item, with an ellipsis menu
 * (Rename/Remove) that appears on hover, and an inline-editable label while renaming.
 *
 * Mutations are submitted by the SideMenu (not here): removing a favorite unmounts this item
 * optimistically, and a fetcher owned by an unmounting component gets its request aborted.
 */
export function FavoriteMenuItem({
  favorite,
  isCollapsed,
  onRemove,
  onRename,
}: {
  favorite: FavoritePage;
  isCollapsed: boolean;
  onRemove: (id: string) => void;
  onRename: (id: string, label: string) => void;
}) {
  const location = useLocation();
  const navigation = useNavigation();
  const isImpersonating = useIsImpersonating();
  const [isEditing, setIsEditing] = useState(false);
  const [isMenuOpen, setMenuOpen] = useState(false);

  // Watch search too: navigating to a favorite can change only the search on the same pathname
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setMenuOpen(false);
  }, [navigation.location?.pathname, navigation.location?.search]);

  const icon = favoritePageIcon(favorite.icon);
  const isActive = isFavoriteActive(favorite, location.pathname, location.search);

  const submitRename = (value: string) => {
    setIsEditing(false);
    const label = value.trim();
    // An empty or unchanged submit reverts to the saved label
    if (label.length === 0 || label === favorite.label) return;
    onRename(favorite.id, label);
  };

  if (isEditing && !isCollapsed) {
    return (
      <FavoriteRenameRow
        label={favorite.label}
        icon={icon}
        iconClassName={favoritePageIconClassName(favorite.icon)}
        onSubmit={submitRename}
        onCancel={() => setIsEditing(false)}
      />
    );
  }

  return (
    <SideMenuItem
      name={favorite.label}
      icon={icon}
      iconClassName={favoritePageIconClassName(favorite.icon)}
      activeIconColor={favoritePageActiveColor(favorite.icon)}
      inactiveIconColor="text-text-dimmed"
      to={favoriteLinkTo(favorite)}
      isCollapsed={isCollapsed}
      isActive={isActive}
      data-action="favorite"
      action={
        // Renaming and removing are preference writes, which impersonated sessions skip, so the
        // menu is left out there rather than appearing to work and reverting.
        !isCollapsed && !isImpersonating ? (
          <Popover open={isMenuOpen} onOpenChange={setMenuOpen}>
            <PopoverCustomTrigger
              aria-label={`Favorite options for ${favorite.label}`}
              className={cn(
                // transition-none: the trigger base has `transition`, which fades the reveal in
                "flex h-full w-full items-center justify-center justify-items-center rounded p-0 transition-none hover:bg-surface-control",
                // Hidden until the row is hovered (or while this menu is open)
                "opacity-0 group-hover/menuitem:opacity-100 data-[state=open]:opacity-100"
              )}
            >
              <EllipsisHorizontalIcon className="size-4" />
            </PopoverCustomTrigger>
            <PopoverContent
              className="w-fit min-w-36 p-1"
              align="start"
              side="right"
              sideOffset={4}
            >
              <div className="flex flex-col gap-1">
                <PopoverMenuItem
                  icon={RenameIcon}
                  title="Rename"
                  leadingIconClassName={SIDE_MENU_POPOVER_ITEM_ICON}
                  className={SIDE_MENU_POPOVER_ITEM_LABEL}
                  onClick={() => {
                    setMenuOpen(false);
                    setIsEditing(true);
                  }}
                />
                <PopoverMenuItem
                  icon={CrossIcon}
                  title="Remove"
                  danger
                  leadingIconClassName="h-5 w-5"
                  className={SIDE_MENU_POPOVER_ITEM_LABEL}
                  onClick={() => {
                    setMenuOpen(false);
                    onRemove(favorite.id);
                  }}
                />
              </div>
            </PopoverContent>
          </Popover>
        ) : undefined
      }
    />
  );
}

/**
 * The inline rename state of a favorite: same row shape as the menu item, but the label is an
 * input. Enter/blur commit, Escape reverts; empty submits revert to the previous name.
 */
function FavoriteRenameRow({
  label,
  icon,
  iconClassName,
  onSubmit,
  onCancel,
}: {
  label: string;
  icon: RenderIcon;
  iconClassName?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(label);
  // Escape unmounts the row, which fires blur — this stops the blur from committing the edit
  const cancelledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  return (
    <div className="flex h-8 w-full items-center gap-2 rounded bg-background-hover pl-1.75 pr-2">
      <Icon icon={icon} className={cn("size-5 shrink-0 text-text-dimmed", iconClassName)} />
      <input
        ref={inputRef}
        autoFocus
        value={value}
        maxLength={64}
        aria-label="Favorite name"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancelledRef.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (!cancelledRef.current) {
            onSubmit(value);
          }
        }}
        className="h-6 w-full min-w-0 flex-1 rounded-sm bg-transparent text-[0.90625rem] font-medium tracking-[-0.01em] text-text-bright outline-none"
      />
    </div>
  );
}
