import { useCallback, useMemo, useState } from "react";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { Link } from "@remix-run/react";
import { cn } from "~/utils/cn";
import { ClipboardCheckIcon, ClipboardIcon, XIcon } from "lucide-react";

type Tag = string | { key: string; value: string };

function TagNotch() {
  return (
    <svg
      width="9"
      height="25"
      viewBox="0 0 9 25"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="block h-full w-2.25"
      aria-hidden="true"
    >
      <path
        d="M8.51694 0.5H10.5V24.5H8.51694C7.17088 24.5 5.94409 23.7281 5.36161 22.5146L1.69703 14.88C0.974863 13.3755 0.974863 11.6245 1.69703 10.12L5.3616 2.48544C5.94409 1.27194 7.17088 0.5 8.51694 0.5Z"
        vectorEffect="non-scaling-stroke"
        className="fill-background-bright stroke-grid-bright"
      />
    </svg>
  );
}

export function RunTag({
  tag,
  to,
  tooltip,
  action = { type: "copy" },
}: {
  tag: string;
  action?: { type: "copy" } | { type: "delete"; onDelete: (tag: string) => void };
  to?: string;
  tooltip?: string;
}) {
  const tagResult = useMemo(() => splitTag(tag), [tag]);
  const [isHovered, setIsHovered] = useState(false);

  // Render the basic tag content
  const renderTagContent = () => {
    if (typeof tagResult === "string") {
      return (
        <>
          <TagNotch />
          <span className="flex items-center rounded-r-sm border-y border-r border-grid-bright bg-background-bright pr-1.5 text-text-dimmed group-hover:rounded-r-none group-hover:group-has-[[href]]:border-border-bright group-hover:group-has-[[href]]:text-text-bright">
            {tag}
          </span>
        </>
      );
    } else {
      return (
        <>
          <TagNotch />
          <span className="flex items-center border-y border-r border-grid-bright bg-background-bright pr-1.5 text-text-dimmed group-hover:group-has-[[href]]:border-border-bright group-hover:group-has-[[href]]:text-text-bright">
            {tagResult.key}
          </span>
          <span className="flex items-center whitespace-nowrap rounded-r-sm border-y border-r border-grid-bright bg-background-hover px-1.5 text-text-dimmed group-hover:rounded-r-none group-hover:group-has-[[href]]:border-border-bright group-hover:group-has-[[href]]:bg-background-raised group-hover:group-has-[[href]]:text-text-bright">
            {tagResult.value}
          </span>
        </>
      );
    }
  };

  // The main tag content, optionally wrapped in a Link and SimpleTooltip
  const tagContent = to ? (
    <SimpleTooltip
      button={
        <Link to={to} className="group shrink-0" onMouseEnter={() => setIsHovered(true)}>
          <span className="flex h-6 items-stretch">{renderTagContent()}</span>
        </Link>
      }
      content={tooltip || `Filter by ${tag}`}
      disableHoverableContent
    />
  ) : (
    <span className="flex h-6 shrink-0 items-stretch" onMouseEnter={() => setIsHovered(true)}>
      {renderTagContent()}
    </span>
  );

  return (
    <div className="group relative inline-flex shrink-0" onMouseLeave={() => setIsHovered(false)}>
      {tagContent}
      {action.type === "delete" ? (
        <DeleteButton tag={tag} onDelete={action.onDelete} isHovered={isHovered} />
      ) : (
        <CopyButton textToCopy={tag} isHovered={isHovered} />
      )}
    </div>
  );
}

function CopyButton({ textToCopy, isHovered }: { textToCopy: string; isHovered: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
    },
    [textToCopy]
  );

  return (
    <SimpleTooltip
      asChild
      tabbable
      button={
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy tag"}
          onClick={copy}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            "absolute -right-6 top-0 z-10 flex size-6 items-center justify-center rounded-r-sm border-y border-r border-border-bright bg-background-hover transition-opacity focus:opacity-100",
            isHovered ? "opacity-100" : "pointer-events-none opacity-0",
            copied
              ? "text-green-500"
              : "text-text-dimmed hover:border-border-bright hover:bg-background-raised hover:text-text-bright"
          )}
        >
          {copied ? (
            <ClipboardCheckIcon className="size-3.5" />
          ) : (
            <ClipboardIcon className="size-3.5" />
          )}
        </button>
      }
      content={copied ? "Copied!" : "Copy tag"}
      disableHoverableContent
    />
  );
}

function DeleteButton({
  tag,
  onDelete,
  isHovered,
}: {
  tag: string;
  onDelete: (tag: string) => void;
  isHovered: boolean;
}) {
  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onDelete(tag);
    },
    [tag, onDelete]
  );

  return (
    <SimpleTooltip
      asChild
      tabbable
      button={
        <button
          type="button"
          aria-label="Remove tag"
          onClick={handleDelete}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            "absolute -right-6 top-0 z-10 flex size-6 items-center justify-center rounded-r-sm border-y border-r border-border-bright bg-background-hover transition-opacity focus:opacity-100",
            isHovered ? "opacity-100" : "pointer-events-none opacity-0",
            "text-text-dimmed hover:border-border-bright hover:bg-background-raised hover:text-rose-400"
          )}
        >
          <XIcon className="size-3.5" />
        </button>
      }
      content="Remove tag"
      disableHoverableContent
    />
  );
}

/** Takes a string and turns it into a tag
 *
 * If the string has 12 or fewer alpha characters followed by an underscore or colon then we return an object with a key and value
 * Otherwise we return the original string
 *
 * Special handling for common ID formats and values with special characters.
 */
export function splitTag(tag: string): Tag {
  const match = tag.match(/^([a-zA-Z0-9]{1,12})[_:](.*?)$/);
  if (!match) return tag;

  const [, key, value] = match;

  const colonCount = (tag.match(/:/g) || []).length;
  const underscoreCount = (tag.match(/_/g) || []).length;

  const hasMultipleColons = colonCount > 1 && !tag.includes("_");
  const hasMultipleUnderscores = underscoreCount > 1 && !tag.includes(":");
  const isLikelyID = hasMultipleColons || hasMultipleUnderscores;

  if (!isLikelyID) return { key, value };

  const isAlphabeticKey = key.match(/^[a-zA-Z]+$/) !== null;
  const hasSpecialFormatChars =
    value.includes("-") || value.includes("T") || value.includes("Z") || value.includes("/");
  const isSpecialFormat = isAlphabeticKey && hasSpecialFormatChars;

  if (isSpecialFormat) return { key, value };

  return tag;
}
