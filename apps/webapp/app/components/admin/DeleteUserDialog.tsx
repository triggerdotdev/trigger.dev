import { Form, useNavigation } from "@remix-run/react";
import { useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from "~/components/primitives/Dialog";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";

type DeleteUserDialogProps = {
  user: { id: string; email: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function DeleteUserDialog({ user, open, onOpenChange }: DeleteUserDialogProps) {
  const navigation = useNavigation();
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (!open) setConfirmText("");
  }, [open]);

  const expected = user ? `delete ${user.email}` : "";
  const confirmed = !!user && confirmText === expected;
  const isSubmitting = navigation.state !== "idle";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>Delete user</DialogHeader>

        {user && (
          <div className="flex flex-col gap-1 rounded-md border border-charcoal-700 bg-charcoal-800 px-3 py-2">
            <Paragraph variant="small" className="text-text-dimmed">
              Target
            </Paragraph>
            <Paragraph variant="base">{user.email}</Paragraph>
            <Paragraph variant="extra-small" className="text-text-dimmed">
              {user.id}
            </Paragraph>
          </div>
        )}

        <Form method="post" className="flex flex-col gap-3" reloadDocument>
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="id" value={user?.id ?? ""} />

          <div className="flex flex-col gap-1">
            <Label>
              Type <code className="rounded bg-charcoal-700 px-1">{expected}</code> to confirm
            </Label>
            <Input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={expected}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="tertiary/medium"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="danger/medium" disabled={!confirmed || isSubmitting}>
              Delete user
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
