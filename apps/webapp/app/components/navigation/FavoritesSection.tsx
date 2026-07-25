import { EllipsisHorizontalIcon, PencilSquareIcon, TrashIcon } from "@heroicons/react/20/solid";
import { useFetcher, useLocation, useNavigation } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { type FavoritePage } from "~/services/dashboardPreferences.server";
import { cn } from "~/utils/cn";
import { Icon, type RenderIcon } from "../primitives/Icon";
import {
  Popover,
  PopoverContent,
  PopoverCustomTrigger,
  PopoverMenuItem,
} from "../primitives/Popover";
import { favoritePageIcon, FAVORITES_ACTION_PATH } from "./favoritePages";
import { SideMenuItem } from "./SideMenuItem";

/**
 * A favorited page in the side menu. Renders like a normal menu item, with an ellipsis menu
 * (Rename/Remove) that appears on hover, and an inline-editable label while renaming.
 */
export function FavoriteMenuItem({
  favorite,
  isCollapsed,
}: {
  favorite: FavoritePage;
  isCollapsed: boolean;
}) {
  const location = useLocation();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const [isEditing, setIsEditing] = useState(false);
  const [isMenuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [navigation.location?.pathname]);

  const icon = favoritePageIcon(favorite.icon);
  const isActive = location.pathname + location.search === favorite.url;

  const submitRename = (value: string) => {
    setIsEditing(false);
    const label = value.trim();
    // An empty or unchanged submit reverts to the saved label
    if (label.length === 0 || label === favorite.label) return;
    fetcher.submit(
      { intent: "rename", id: favorite.id, label },
      { method: "POST", action: FAVORITES_ACTION_PATH }
    );
  };

  const remove = () => {
    fetcher.submit(
      { intent: "remove", id: favorite.id },
      { method: "POST", action: FAVORITES_ACTION_PATH }
    );
  };

  if (isEditing && !isCollapsed) {
    return (
      <FavoriteRenameRow
        label={favorite.label}
        icon={icon}
        onSubmit={submitRename}
        onCancel={() => setIsEditing(false)}
      />
    );
  }

  return (
    <SideMenuItem
      name={favorite.label}
      icon={icon}
      activeIconColor="text-text-bright"
      inactiveIconColor="text-text-dimmed"
      to={favorite.url}
      isCollapsed={isCollapsed}
      isActive={isActive}
      data-action="favorite"
      action={
        !isCollapsed ? (
          <Popover open={isMenuOpen} onOpenChange={setMenuOpen}>
            <PopoverCustomTrigger
              aria-label={`Favorite options for ${favorite.label}`}
              className={cn(
                "flex h-full w-full items-center justify-center justify-items-center rounded p-0 hover:bg-surface-control",
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
                  icon={PencilSquareIcon}
                  title="Rename"
                  leadingIconClassName="size-4 text-text-dimmed"
                  onClick={() => {
                    setMenuOpen(false);
                    setIsEditing(true);
                  }}
                />
                <PopoverMenuItem
                  icon={TrashIcon}
                  title="Remove"
                  danger
                  leadingIconClassName="size-4"
                  onClick={() => {
                    setMenuOpen(false);
                    remove();
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
  onSubmit,
  onCancel,
}: {
  label: string;
  icon: RenderIcon;
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
      <Icon icon={icon} className="size-5 shrink-0 text-text-dimmed" />
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
