import { CheckIcon } from "@heroicons/react/20/solid";
import {
  IconAlarmSnooze as IconAlarmSnoozeBase,
  IconArrowBackUp as IconArrowBackUpBase,
  IconBugOff as IconBugOffBase,
} from "@tabler/icons-react";
import { useState } from "react";
import { type ErrorGroupStatus } from "@trigger.dev/database";
import { Form, useNavigation, useSubmit } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/primitives/Dialog";

const AlarmSnoozeIcon = ({ className }: { className?: string }) => (
  <IconAlarmSnoozeBase className={className} size={18} />
);
const ArrowBackUpIcon = ({ className }: { className?: string }) => (
  <IconArrowBackUpBase className={className} size={18} />
);
const BugOffIcon = ({ className }: { className?: string }) => (
  <IconBugOffBase className={className} size={18} />
);

export function ErrorStatusMenuItems({
  status,
  taskIdentifier,
  onAction,
  onCustomIgnore,
}: {
  status: ErrorGroupStatus;
  taskIdentifier: string;
  onAction: (data: Record<string, string>) => void;
  onCustomIgnore: () => void;
}) {
  return (
    <>
      {status === "UNRESOLVED" && (
        <>
          <PopoverMenuItem
            icon={CheckIcon}
            leadingIconClassName="text-success"
            title="Resolved"
            onClick={() => onAction({ taskIdentifier, action: "resolve" })}
          />
          <PopoverMenuItem
            icon={AlarmSnoozeIcon}
            leadingIconClassName="text-blue-500"
            title="Ignored for 1 hour"
            onClick={() =>
              onAction({
                taskIdentifier,
                action: "ignore",
                duration: String(60 * 60 * 1000),
              })
            }
          />
          <PopoverMenuItem
            icon={AlarmSnoozeIcon}
            leadingIconClassName="text-blue-500"
            title="Ignored for 24 hours"
            onClick={() =>
              onAction({
                taskIdentifier,
                action: "ignore",
                duration: String(24 * 60 * 60 * 1000),
              })
            }
          />
          <PopoverMenuItem
            icon={BugOffIcon}
            leadingIconClassName="text-blue-500"
            title="Ignored forever"
            onClick={() => onAction({ taskIdentifier, action: "ignore" })}
          />
          <PopoverMenuItem
            icon={AlarmSnoozeIcon}
            leadingIconClassName="text-blue-500"
            title="Ignored with custom condition…"
            onClick={onCustomIgnore}
          />
        </>
      )}

      {status === "IGNORED" && (
        <>
          <PopoverMenuItem
            icon={CheckIcon}
            leadingIconClassName="text-success"
            title="Resolved"
            onClick={() => onAction({ taskIdentifier, action: "resolve" })}
          />
          <PopoverMenuItem
            icon={ArrowBackUpIcon}
            leadingIconClassName="text-error"
            title="Unresolved"
            onClick={() => onAction({ taskIdentifier, action: "unresolve" })}
          />
        </>
      )}

      {status === "RESOLVED" && (
        <PopoverMenuItem
          icon={ArrowBackUpIcon}
          leadingIconClassName="text-error"
          title="Unresolved"
          onClick={() => onAction({ taskIdentifier, action: "unresolve" })}
        />
      )}
    </>
  );
}

export function CustomIgnoreDialog({
  open,
  onOpenChange,
  taskIdentifier,
  formAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskIdentifier: string;
  formAction?: string;
}) {
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const [conditionError, setConditionError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <IconAlarmSnoozeBase className="-ml-1.5 size-6 text-blue-500" />
            Custom ignore condition
          </DialogTitle>
        </DialogHeader>
        <Form
          method="post"
          action={formAction}
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            const rate = formData.get("occurrenceRate")?.toString().trim();
            const total = formData.get("totalOccurrences")?.toString().trim();

            if (!rate && !total) {
              setConditionError("At least one unignore condition is required");
              return;
            }

            setConditionError(null);
            submit(e.currentTarget, { method: "post", action: formAction });
            setTimeout(() => onOpenChange(false), 100);
          }}
        >
          <input type="hidden" name="action" value="ignore" />
          <input type="hidden" name="taskIdentifier" value={taskIdentifier} />

          <div className="flex flex-col gap-4 py-4">
            <InputGroup fullWidth>
              <Label htmlFor="occurrenceRate" variant="small">
                Unignore when occurrence rate exceeds (per minute)
              </Label>
              <Input
                id="occurrenceRate"
                name="occurrenceRate"
                type="number"
                min={1}
                placeholder="e.g. 10"
                onChange={() => conditionError && setConditionError(null)}
              />
            </InputGroup>

            <InputGroup fullWidth>
              <Label htmlFor="totalOccurrences" variant="small">
                Unignore when total occurrences exceed
              </Label>
              <Input
                id="totalOccurrences"
                name="totalOccurrences"
                type="number"
                min={1}
                placeholder="e.g. 100"
                onChange={() => conditionError && setConditionError(null)}
              />
            </InputGroup>

            {conditionError && <FormError>{conditionError}</FormError>}

            <InputGroup fullWidth>
              <Label htmlFor="reason" variant="small" required={false}>
                Reason
              </Label>
              <Input id="reason" name="reason" type="text" placeholder="e.g. Known flaky test" />
            </InputGroup>
          </div>

          <DialogFooter>
            <Button variant="tertiary/medium" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary/medium" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Ignoring…" : "Ignore error"}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
