import {
  BellAlertIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
} from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
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
  const prevNotificationIdsRef = useRef<Set<string>>(new Set());
  const [animateNew, setAnimateNew] = useState(false);

  const visibleNotifications = notifications.filter((n) => !dismissedIds.has(n.id));

  // Detect newly arrived notifications
  useEffect(() => {
    const currentIds = new Set(visibleNotifications.map((n) => n.id));
    const prevIds = prevNotificationIdsRef.current;
    const hasNew = visibleNotifications.some((n) => !prevIds.has(n.id));

    if (hasNew && prevIds.size > 0) {
      setAnimateNew(true);
    }

    prevNotificationIdsRef.current = currentIds;
  }, [visibleNotifications]);

  // Auto-reset animation flag
  useEffect(() => {
    if (animateNew) {
      const timer = setTimeout(() => setAnimateNew(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [animateNew]);

  const handleDismiss = useCallback(
    (id: string) => {
      setDismissedIds((prev) => new Set(prev).add(id));

      dismissFetcher.submit(
        {},
        {
          method: "POST",
          action: `/resources/platform-notifications/${id}/dismiss`,
        }
      );
    },
    []
  );

  if (visibleNotifications.length === 0) {
    return null;
  }

  return (
    <Popover>
      <div className="p-1">
        <motion.div
          initial={false}
          animate={{
            height: isCollapsed ? 0 : "auto",
            opacity: isCollapsed ? 0 : 1,
          }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          <NotificationPanelContent
            notifications={visibleNotifications}
            hasIncident={hasIncident}
            organizationId={organizationId}
            onDismiss={handleDismiss}
            animateNew={animateNew}
          />
        </motion.div>

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
                <motion.div
                  className="relative"
                  animate={
                    animateNew
                      ? { rotate: [0, -15, 15, -10, 10, -5, 5, 0] }
                      : { rotate: 0 }
                  }
                  transition={{ duration: 0.5 }}
                >
                  <BellAlertIcon className="size-5 text-text-dimmed" />
                  {visibleNotifications.length > 0 && (
                    <motion.span
                      className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-white"
                      style={{ backgroundColor: "#6366f1" }}
                      animate={
                        animateNew
                          ? {
                              scale: [1, 1.4, 1],
                              backgroundColor: ["#6366f1", "#22c55e", "#6366f1"],
                            }
                          : { scale: 1 }
                      }
                      transition={{ duration: 0.6 }}
                    >
                      {visibleNotifications.length}
                    </motion.span>
                  )}
                </motion.div>
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
        <NotificationPanelContent
          notifications={visibleNotifications}
          hasIncident={hasIncident}
          organizationId={organizationId}
          onDismiss={handleDismiss}
          animateNew={animateNew}
        />
      </PopoverContent>
    </Popover>
  );
}

function NotificationPanelContent({
  notifications,
  hasIncident,
  organizationId,
  onDismiss,
  animateNew,
}: {
  notifications: Notification[];
  hasIncident: boolean;
  organizationId: string;
  onDismiss: (id: string) => void;
  animateNew: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const seenFetcher = useFetcher();

  // Clamp currentIndex if notifications change
  const clampedIndex = Math.min(currentIndex, Math.max(0, notifications.length - 1));
  if (clampedIndex !== currentIndex) {
    setCurrentIndex(clampedIndex);
  }

  const currentNotification = notifications[clampedIndex];

  // Fire seen beacon when a card comes into view
  const fireSeenBeacon = useCallback(
    (notification: Notification) => {
      if (seenIdsRef.current.has(notification.id)) return;
      seenIdsRef.current.add(notification.id);

      seenFetcher.submit(
        {},
        {
          method: "POST",
          action: `/resources/platform-notifications/${notification.id}/seen`,
        }
      );
    },
    []
  );

  // Beacon current card on mount and when carousel navigates
  useEffect(() => {
    if (currentNotification && isExpanded && !hasIncident) {
      fireSeenBeacon(currentNotification);
    }
  }, [clampedIndex, isExpanded, hasIncident, currentNotification]);

  const handleDismiss = useCallback(
    (notification: Notification) => {
      onDismiss(notification.id);

      // Adjust index if dismissed card was before/at current position
      if (clampedIndex >= notifications.length - 1) {
        setCurrentIndex(Math.max(0, clampedIndex - 1));
      }
    },
    [onDismiss, clampedIndex, notifications.length]
  );

  const handleAction = useCallback(
    (notification: Notification) => {
      if (notification.payload.data.dismissOnAction) {
        handleDismiss(notification);
      }
    },
    [handleDismiss]
  );

  const effectiveExpanded = isExpanded && !hasIncident;

  return (
    <div className="flex flex-col rounded border border-charcoal-650 bg-charcoal-750/50">
      {/* Card area */}
      {effectiveExpanded && currentNotification && (
        <motion.div
          initial={false}
          animate={{ height: "auto", opacity: 1 }}
          transition={{ duration: 0.15 }}
          className="overflow-hidden"
        >
          {/* Header: title + minimize */}
          <div className="flex items-start gap-1 px-2 pt-1.5">
            <Paragraph variant="small/bright" className="flex-1 text-text-bright">
              {currentNotification.payload.data.title}
            </Paragraph>
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="shrink-0 rounded p-0.5 text-text-dimmed transition-colors hover:bg-charcoal-700 hover:text-text-bright"
            >
              <MinusIcon className="size-3.5" />
            </button>
          </div>

          {/* Body */}
          <div className="max-h-[265px] overflow-y-auto px-2 pb-2">
            <div className="flex flex-col gap-1.5">
              <NotificationDescription
                description={currentNotification.payload.data.description}
                hasImage={!!currentNotification.payload.data.image}
              />

              {currentNotification.payload.data.image && (
                <img
                  src={currentNotification.payload.data.image}
                  alt=""
                  className="mt-1 rounded"
                />
              )}

              <div className="mt-1 grid grid-cols-2 gap-2">
                {currentNotification.payload.data.actionLabel && currentNotification.payload.data.actionUrl ? (
                  <LinkButton
                    variant="primary/small"
                    to={currentNotification.payload.data.actionUrl}
                    target="_blank"
                    onClick={() => handleAction(currentNotification)}
                    fullWidth
                  >
                    {currentNotification.payload.data.actionLabel}
                  </LinkButton>
                ) : (
                  <span />
                )}
                <Button
                  variant="tertiary/small"
                  onClick={() => handleDismiss(currentNotification)}
                  fullWidth
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>

          {/* Carousel navigation */}
          {notifications.length > 1 && (
            <div className="flex items-center justify-between border-t border-charcoal-650 px-2 py-1">
              <div className="flex items-center">
                {notifications.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setCurrentIndex(0)}
                    disabled={clampedIndex === 0}
                    className="rounded p-0.5 text-text-dimmed transition-colors hover:text-text-bright disabled:opacity-30"
                  >
                    <ChevronDoubleLeftIcon className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                  disabled={clampedIndex === 0}
                  className="rounded p-0.5 text-text-dimmed transition-colors hover:text-text-bright disabled:opacity-30"
                >
                  <ChevronLeftIcon className="size-3.5" />
                </button>
              </div>
              <span className="text-[10px] tabular-nums text-text-dimmed">
                {clampedIndex + 1} / {notifications.length}
              </span>
              <div className="flex items-center">
                <button
                  type="button"
                  onClick={() =>
                    setCurrentIndex((i) => Math.min(notifications.length - 1, i + 1))
                  }
                  disabled={clampedIndex === notifications.length - 1}
                  className="rounded p-0.5 text-text-dimmed transition-colors hover:text-text-bright disabled:opacity-30"
                >
                  <ChevronRightIcon className="size-3.5" />
                </button>
                {notifications.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setCurrentIndex(notifications.length - 1)}
                    disabled={clampedIndex === notifications.length - 1}
                    className="rounded p-0.5 text-text-dimmed transition-colors hover:text-text-bright disabled:opacity-30"
                  >
                    <ChevronDoubleRightIcon className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}
        </motion.div>
      )}

      {/* Banner bar */}
      <button
        type="button"
        onClick={() => {
          if (!hasIncident) setIsExpanded((e) => !e);
        }}
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5",
          effectiveExpanded && "border-t border-charcoal-650",
          !hasIncident && "cursor-pointer hover:bg-charcoal-700/50",
          hasIncident && "cursor-default"
        )}
      >
        <motion.div
          animate={
            animateNew
              ? { rotate: [0, -15, 15, -10, 10, -5, 5, 0] }
              : { rotate: 0 }
          }
          transition={{ duration: 0.5 }}
        >
          <BellAlertIcon className="size-3.5 shrink-0 text-text-dimmed" />
        </motion.div>
        <Paragraph variant="extra-small" className="flex-1 truncate text-left text-text-bright">
          {notifications[0]?.payload.data.title}
        </Paragraph>
        {notifications.length > 1 && (
          <motion.span
            className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium text-text-bright"
            style={{ backgroundColor: "#3B3E45" }}
            animate={
              animateNew
                ? {
                    scale: [1, 1.4, 1],
                    backgroundColor: ["#3B3E45", "#22c55e", "#3B3E45"],
                  }
                : { scale: 1 }
            }
            transition={{ duration: 0.6 }}
          >
            {notifications.length}
          </motion.span>
        )}
      </button>
    </div>
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
      className="text-indigo-400 underline"
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

function NotificationDescription({
  description,
  hasImage,
}: {
  description: string;
  hasImage: boolean;
}) {
  const charLimit = hasImage ? 140 : 280;
  const needsTruncation = description.length > charLimit;
  const [isShowingMore, setIsShowingMore] = useState(false);

  const displayText = useMemo(() => {
    if (!needsTruncation || isShowingMore) return description;
    return description.slice(0, charLimit) + "…";
  }, [description, charLimit, needsTruncation, isShowingMore]);

  const toggle = needsTruncation ? (
    <>
      {" "}
      <button
        type="button"
        onClick={() => setIsShowingMore((v) => !v)}
        className="inline text-xs text-indigo-400 hover:text-indigo-300"
      >
        {isShowingMore ? "Show less" : "Show more"}
      </button>
    </>
  ) : null;

  return (
    <div>
      <MarkdownWithSuffix text={displayText} suffix={toggle} />
    </div>
  );
}

function MarkdownWithSuffix({ text, suffix }: { text: string; suffix: React.ReactNode }) {
  const pCountRef = useRef(0);
  const totalParagraphs = useMemo(() => (text.match(/(?:^|\n\n)(?!\s*$)/g) || [""]).length, [text]);

  // Reset counter each render
  pCountRef.current = 0;

  if (!suffix) {
    return <ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown>;
  }

  const components = {
    ...markdownComponents,
    p: ({ children }: { children?: React.ReactNode }) => {
      pCountRef.current++;
      const isLast = pCountRef.current >= totalParagraphs;
      return (
        <p className="my-0.5 text-xs leading-relaxed text-text-dimmed">
          {children}
          {isLast && suffix}
        </p>
      );
    },
  };

  return <ReactMarkdown components={components}>{text}</ReactMarkdown>;
}
