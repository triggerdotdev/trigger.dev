import { useFetcher } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import simplur from "simplur";
import { NotificationIcon } from "~/assets/icons/NotificationIcon";
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
  const { submit: submitDismiss } = useFetcher();
  const seenIdsRef = useRef<Set<string>>(new Set());
  const { submit: submitSeen } = useFetcher();
  const clickedIdsRef = useRef<Set<string>>(new Set());
  const { submit: submitClick } = useFetcher();

  const visibleNotifications = notifications.filter((n) => !dismissedIds.has(n.id));
  const notification = visibleNotifications[0] ?? null;
  const notificationId = notification?.id;

  const handleDismiss = useCallback(
    (id: string) => {
      setDismissedIds((prev) => new Set(prev).add(id));

      submitDismiss(
        {},
        {
          method: "POST",
          action: `/resources/platform-notifications/${id}/dismiss`,
        }
      );
    },
    [submitDismiss]
  );

  const fireClickBeacon = useCallback(
    (id: string) => {
      if (clickedIdsRef.current.has(id)) return;
      clickedIdsRef.current.add(id);

      submitClick(
        {},
        {
          method: "POST",
          action: `/resources/platform-notifications/${id}/clicked`,
        }
      );
    },
    [submitClick]
  );

  // Fire seen beacon
  const fireSeenBeacon = useCallback(
    (id: string) => {
      if (seenIdsRef.current.has(id)) return;
      seenIdsRef.current.add(id);

      submitSeen(
        {},
        {
          method: "POST",
          action: `/resources/platform-notifications/${id}/seen`,
        }
      );
    },
    [submitSeen]
  );

  // Beacon current notification on mount
  useEffect(() => {
    if (notificationId && !hasIncident) {
      fireSeenBeacon(notificationId);
    }
  }, [notificationId, hasIncident, fireSeenBeacon]);

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
      <div className={isCollapsed ? "p-1" : "p-2 pt-0"}>
        {isCollapsed ? (
          <SimpleTooltip
            asChild
            button={
              <div className="relative">
                <PopoverTrigger asChild>
                  <Button variant="small-menu-item" className="h-8 w-8.75 justify-center">
                    <NotificationIcon className="size-5 text-success" />
                  </Button>
                </PopoverTrigger>
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
      <PopoverContent side="right" sideOffset={8} align="end" className="w-56 min-w-0! p-0">
        {card}
      </PopoverContent>
    </Popover>
  );
}
