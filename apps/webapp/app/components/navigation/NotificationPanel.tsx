import { BellAlertIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Header3 } from "~/components/primitives/Headers";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { usePlatformNotifications } from "~/routes/resources.platform-notifications";
import { cn } from "~/utils/cn";

type Notification = {
  id: string;
  friendlyId: string;
  scope: string;
  priority: number;
  payload: {
    version: string;
    data: {
      title: string;
      description: string;
      image?: string;
      actionLabel?: string;
      actionUrl?: string;
      dismissOnAction?: boolean;
    };
  };
  isRead: boolean;
};

export function NotificationPanel({
  isCollapsed,
  hasIncident,
  organizationId,
  projectId,
}: {
  isCollapsed: boolean;
  hasIncident: boolean;
  organizationId: string;
  projectId: string;
}) {
  const { notifications } = usePlatformNotifications(organizationId, projectId) as {
    notifications: Notification[];
  };
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const dismissFetcher = useFetcher();
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seenFetcher = useFetcher();

  const visibleNotifications = notifications.filter((n) => !dismissedIds.has(n.id));
  const notification = visibleNotifications[0] ?? null;

  const handleDismiss = useCallback((id: string) => {
    setDismissedIds((prev) => new Set(prev).add(id));

    dismissFetcher.submit(
      {},
      {
        method: "POST",
        action: `/resources/platform-notifications/${id}/dismiss`,
      }
    );
  }, []);

  // Fire seen beacon
  const fireSeenBeacon = useCallback((n: Notification) => {
    if (seenIdsRef.current.has(n.id)) return;
    seenIdsRef.current.add(n.id);

    seenFetcher.submit(
      {},
      {
        method: "POST",
        action: `/resources/platform-notifications/${n.id}/seen`,
      }
    );
  }, []);

  // Beacon current notification on mount
  useEffect(() => {
    if (notification && !hasIncident) {
      fireSeenBeacon(notification);
    }
  }, [notification?.id, hasIncident]);

  if (!notification) {
    return null;
  }

  const card = (
    <NotificationCard
      notification={notification}
      onDismiss={handleDismiss}
    />
  );

  return (
    <Popover>
      <div className="p-1">
        {/* Expanded sidebar: show card directly */}
        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? 0 : "auto",
            opacity: isCollapsed ? 0 : 1,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          {card}
        </motion.div>

        {/* Collapsed sidebar: show bell icon that opens popover */}
        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? "auto" : 0,
            opacity: isCollapsed ? 1 : 0,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <SimpleTooltip
            button={
              <PopoverTrigger className="flex !h-8 w-full items-center justify-center rounded border border-charcoal-650 bg-charcoal-750/50 transition-colors hover:border-charcoal-600 hover:bg-charcoal-700/50">
                <div className="relative">
                  <BellAlertIcon className="size-5 text-text-dimmed" />
                  <span
                    className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white"
                    style={{ backgroundColor: "#6366f1" }}
                  >
                    {visibleNotifications.length}
                  </span>
                </div>
              </PopoverTrigger>
            }
            content="Notifications"
            side="right"
            sideOffset={8}
            disableHoverableContent
            asChild
          />
        </motion.div>
      </div>
      <PopoverContent side="right" sideOffset={8} align="start" className="w-56 !min-w-0 p-0">
        {card}
      </PopoverContent>
    </Popover>
  );
}

function NotificationCard({
  notification,
  onDismiss,
}: {
  notification: Notification;
  onDismiss: (id: string) => void;
}) {
  const { title, description, image, actionUrl, dismissOnAction } = notification.payload.data;
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const descriptionRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = descriptionRef.current;
    if (el) {
      setIsOverflowing(el.scrollHeight > el.clientHeight);
    }
  }, [description]);

  const handleDismiss = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDismiss(notification.id);
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsExpanded((v) => !v);
  };

  const handleCardClick = () => {
    if (dismissOnAction) {
      onDismiss(notification.id);
    }
  };

  const Wrapper = actionUrl ? "a" : "div";
  const wrapperProps = actionUrl
    ? {
        href: actionUrl,
        target: "_blank" as const,
        rel: "noopener noreferrer" as const,
        onClick: handleCardClick,
      }
    : {};

  return (
    <Wrapper
      {...wrapperProps}
      className="group/card group relative block overflow-hidden rounded border transition-colors border-grid-bright bg-charcoal-750/50 no-underline"
    >
      {/* Header: title + dismiss */}
      <div className="relative flex items-start gap-1 px-2 pt-1.5">
        <Header3 className="flex-1 !text-xs">
          {title}
        </Header3>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 rounded p-0.5 text-text-dimmed transition-colors hover:bg-charcoal-700 hover:text-text-bright"
        >
          <XMarkIcon className="size-3.5" />
        </button>
      </div>

      {/* Body: description + chevron */}
      <div className="relative px-2 pb-2">
        <div className="flex gap-1">
          <div className="min-w-0 flex-1">
            <div
              ref={descriptionRef}
              className={cn(!isExpanded && "line-clamp-3")}
            >
              <ReactMarkdown components={markdownComponents}>{description}</ReactMarkdown>
            </div>
            {(isOverflowing || isExpanded) && (
              <button
                type="button"
                onClick={handleToggleExpand}
                className="mt-0.5 text-xs text-indigo-400 hover:text-indigo-300"
              >
                {isExpanded ? "Show less" : "Show more"}
              </button>
            )}
          </div>
          {actionUrl && (
            <div className="mt-1 flex shrink-0 items-center pb-1 text-text-dimmed group-hover/card:text-text-bright transition-colors">
              <ChevronRightIcon className="size-4" />
            </div>
          )}
        </div>

        {image && (
          <img src={image} alt="" className="mt-1.5 rounded" />
        )}
      </div>
    </Wrapper>
  );
}

const markdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="my-0.5 text-xs leading-relaxed text-text-dimmed">{children}</p>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-indigo-400 underline hover:text-indigo-300 transition-colors"
    >
      {children}
    </a>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-text-bright">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => <em>{children}</em>,
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded bg-charcoal-700 px-1 py-0.5 text-[11px]">{children}</code>
  ),
};
