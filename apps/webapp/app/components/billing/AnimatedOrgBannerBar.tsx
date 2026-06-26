import { ExclamationCircleIcon } from "@heroicons/react/20/solid";
import { AnimatePresence, motion } from "framer-motion";
import tileBgPath from "~/assets/images/error-banner-tile@2x.png";
import { Icon } from "~/components/primitives/Icon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { cn } from "~/utils/cn";

type AnimatedOrgBannerBarProps = {
  show: boolean;
  variant: "warning" | "error";
  children: React.ReactNode;
  action?: React.ReactNode;
};

export function AnimatedOrgBannerBar({
  show,
  variant,
  children,
  action,
}: AnimatedOrgBannerBarProps) {
  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          className={cn(
            "flex h-10 items-center justify-between overflow-hidden py-0 pl-3 pr-2",
            variant === "warning"
              ? "border-y border-amber-400/20 bg-warning/20"
              : "border border-error bg-repeat"
          )}
          style={
            variant === "error"
              ? { backgroundImage: `url(${tileBgPath})`, backgroundSize: "8px 8px" }
              : undefined
          }
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "2.5rem" }}
          exit={{ opacity: 0, height: 0 }}
        >
          <div className="flex items-center gap-2">
            <Icon
              icon={ExclamationCircleIcon}
              className={cn("h-5 w-5", variant === "warning" ? "text-amber-400" : "text-error")}
            />
            <Paragraph
              variant="small"
              className={variant === "warning" ? "text-amber-200" : "text-error"}
            >
              {children}
            </Paragraph>
          </div>
          {action}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
