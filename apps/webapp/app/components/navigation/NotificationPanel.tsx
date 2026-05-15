import { BellAlertIcon } from "@heroicons/react/20/solid";
import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import simplur from "simplur";
import { Button } from "~/components/primitives/Buttons";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { usePlatformNotifications } from "~/routes/resources.platform-notifications";
import { NotificationCard } from "./NotificationCard";

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
  const clickedIdsRef = useRef<Set<string>>(new Set());
  const clickFetcher = useFetcher();

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

  const fireClickBeacon = useCallback((id: string) => {
    if (clickedIdsRef.current.has(id)) return;
    clickedIdsRef.current.add(id);

    clickFetcher.submit(
      {},
      {
        method: "POST",
        action: `/resources/platform-notifications/${id}/clicked`,
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

  const { title, description, image, actionUrl, dismissOnAction } = notification.payload.data;
  const card = (
    <NotificationCard
      title={title}
      description={description}
      image={image}
      actionUrl={actionUrl}
      onDismiss={() => handleDismiss(notification.id)}
      onCardClick={() => {
        fireClickBeacon(notification.id);
        if (dismissOnAction) {
          handleDismiss(notification.id);
        }
      }}
      onLinkClick={() => fireClickBeacon(notification.id)}
    />
  );

  return (
    <Popover>
      <div className={isCollapsed ? "p-1" : "p-2"}>
        {isCollapsed ? (
          <SimpleTooltip
            asChild
            button={
              <div className="relative">
                <PopoverTrigger asChild>
                  <Button variant="small-menu-item" className="h-8 w-[2.1875rem] justify-center">
                    <BellAlertIcon className="size-5" />
                  </Button>
                </PopoverTrigger>
                <span
                  className="pointer-events-none absolute -top-[0.2rem] right-0 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-medium text-text-bright"
                  style={{ backgroundColor: "#6366f1" }}
                >
                  {visibleNotifications.length}
                </span>
              </div>
            }
            content={simplur`${visibleNotifications.length} notification[|s]`}
            side="right"
            sideOffset={8}
            disableHoverableContent
          />
        ) : (
          card
        )}
      </div>
      <PopoverContent side="right" sideOffset={8} align="end" className="w-56 !min-w-0 p-0">
        {card}
      </PopoverContent>
    </Popover>
  );
}
