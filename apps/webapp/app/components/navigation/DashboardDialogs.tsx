import { DialogClose } from "@radix-ui/react-dialog";
import { Form, useNavigation } from "@remix-run/react";
import { motion } from "framer-motion";
import { PlusIcon } from "@heroicons/react/20/solid";
import { useEffect, useState } from "react";
import { type MatchedOrganization, useDashboardLimits } from "~/hooks/useOrganizations";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { Feedback } from "~/components/Feedback";
import { Button, LinkButton } from "../primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTrigger,
} from "../primitives/Dialog";
import { FormButtons } from "../primitives/FormButtons";
import { Input } from "../primitives/Input";
import { InputGroup } from "../primitives/InputGroup";
import { Label } from "../primitives/Label";
import { Paragraph } from "../primitives/Paragraph";
import { TextLink } from "../primitives/TextLink";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../primitives/Tooltip";
import { v3BillingPath } from "~/utils/pathBuilder";
import { type SideMenuEnvironment, type SideMenuProject } from "./SideMenu";

export function CreateDashboardButton({
  organization,
  project,
  environment,
  isCollapsed,
}: {
  organization: MatchedOrganization;
  project: SideMenuProject;
  environment: SideMenuEnvironment;
  isCollapsed: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const navigation = useNavigation();
  const limits = useDashboardLimits();
  const plan = useCurrentPlan();

  const isAtLimit = limits.used >= limits.limit;
  const planLimits = (plan?.v3Subscription?.plan?.limits as any)?.metricDashboards;
  const canExceed = typeof planLimits === "object" && planLimits.canExceed === true;
  const canUpgrade = plan?.v3Subscription?.plan && !canExceed;

  const formAction = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/dashboards/create`;

  // Close dialog when form submission starts (redirect is happening)
  useEffect(() => {
    if (navigation.formAction === formAction && navigation.state === "loading") {
      setIsOpen(false);
    }
  }, [navigation.formAction, navigation.state, formAction]);

  if (isCollapsed) return null;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <TooltipProvider disableHoverableContent>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <button
                type="button"
                className="flex h-full w-full items-center justify-center rounded text-text-dimmed transition focus-custom hover:bg-charcoal-600 hover:text-text-bright"
              >
                <PlusIcon className="size-4" />
              </button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            Create dashboard
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {isAtLimit ? (
        <CreateDashboardUpgradeDialog
          limits={limits}
          canUpgrade={!!canUpgrade}
          organization={organization}
        />
      ) : (
        <CreateDashboardDialog formAction={formAction} limits={limits} />
      )}
    </Dialog>
  );
}

const PROGRESS_RING_R = 27.5;
const PROGRESS_RING_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RING_R;
const PROGRESS_COLOR_SUCCESS = "#28BF5C"; // mint-500 / success
const PROGRESS_COLOR_ERROR = "#E11D48"; // rose-600 / error

function CreateDashboardUpgradeDialog({
  limits,
  canUpgrade,
  organization,
}: {
  limits: { used: number; limit: number };
  canUpgrade: boolean;
  organization: MatchedOrganization;
}) {
  const percentage = Math.min(limits.used / limits.limit, 1);
  const filled = percentage * PROGRESS_RING_CIRCUMFERENCE;

  return (
    <DialogContent>
      <DialogHeader>Dashboard limit reached</DialogHeader>
      <div className="flex items-center gap-4 pt-3">
        <div className="relative ml-1 mt-2 shrink-0" style={{ width: 60, height: 60 }}>
          <svg className="h-full w-full -rotate-90 overflow-visible">
            <circle
              className="fill-none stroke-grid-bright"
              strokeWidth="5"
              r={PROGRESS_RING_R}
              cx="30"
              cy="30"
            />
            <motion.circle
              className="fill-none"
              strokeWidth="5"
              r={PROGRESS_RING_R}
              cx="30"
              cy="30"
              strokeLinecap="round"
              initial={{
                strokeDasharray: `0 ${PROGRESS_RING_CIRCUMFERENCE}`,
                stroke: PROGRESS_COLOR_SUCCESS,
              }}
              animate={{
                strokeDasharray: `${filled} ${PROGRESS_RING_CIRCUMFERENCE}`,
                stroke: PROGRESS_COLOR_ERROR,
              }}
              transition={{ duration: 1.2, ease: "easeInOut" }}
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-lg text-text-dimmed">
            {limits.limit}
          </span>
        </div>
        <DialogDescription className="pt-0">
          {canUpgrade ? (
            <>
              You've used all {limits.limit} of your custom dashboards. Upgrade your plan to create
              more.
            </>
          ) : (
            <>
              You've used all {limits.limit} of your custom dashboards. To create more, request a
              limit increase or visit the{" "}
              <TextLink to={v3BillingPath(organization)}>billing page</TextLink> for pricing
              details.
            </>
          )}
        </DialogDescription>
      </div>
      <DialogFooter className="flex justify-between">
        <DialogClose asChild>
          <Button variant="secondary/medium">Cancel</Button>
        </DialogClose>
        {canUpgrade ? (
          <LinkButton variant="primary/medium" to={v3BillingPath(organization)}>
            Upgrade plan
          </LinkButton>
        ) : (
          <Feedback
            button={<Button variant="primary/medium">Request more…</Button>}
            defaultValue="help"
          />
        )}
      </DialogFooter>
    </DialogContent>
  );
}

function CreateDashboardDialog({
  formAction,
  limits,
}: {
  formAction: string;
  limits: { used: number; limit: number };
}) {
  const navigation = useNavigation();
  const [title, setTitle] = useState("");

  const isLoading = navigation.formAction === formAction;

  return (
    <DialogContent className="sm:max-w-sm">
      <DialogHeader>Create dashboard</DialogHeader>
      <Form method="post" action={formAction} className="space-y-4 pt-3">
        <InputGroup>
          <Label>Title</Label>
          <Input
            name="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="My Dashboard"
            required
          />
        </InputGroup>
        <Paragraph variant="extra-small" className="text-text-dimmed">
          {limits.used}/{limits.limit} dashboards used
        </Paragraph>
        <FormButtons
          confirmButton={
            <Button type="submit" variant="primary/medium" disabled={isLoading || !title.trim()}>
              {isLoading ? "Creating..." : "Create"}
            </Button>
          }
          cancelButton={
            <DialogClose asChild>
              <Button variant="secondary/medium">Cancel</Button>
            </DialogClose>
          }
        />
      </Form>
    </DialogContent>
  );
}
