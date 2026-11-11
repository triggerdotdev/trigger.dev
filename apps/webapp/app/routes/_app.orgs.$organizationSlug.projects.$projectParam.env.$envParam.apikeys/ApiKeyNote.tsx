import { PencilIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form } from "@remix-run/react";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TruncatedText } from "~/components/primitives/TruncatedText";
import { API_KEY_NOTE_TOO_LONG_MESSAGE, isApiKeyNoteTooLong } from "~/utils/apiKeyNote";
import { cn } from "~/utils/cn";
import { actionButtonProps } from "./ApiKeyActions";

export const API_KEY_NOTE_FIELD = "description";

export function ApiKeyNoteInput({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  // No maxLength on the input: it counts raw characters, so a pasted note with long whitespace
  // runs would be cut short even though it fits once the whitespace collapses.
  const tooLong = isApiKeyNoteTooLong(value);
  return (
    <InputGroup fullWidth>
      <Label htmlFor="api-key-note">
        Note <span className="text-text-dimmed">(optional)</span>
      </Label>
      <Input
        id="api-key-note"
        name={API_KEY_NOTE_FIELD}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="e.g. Used by the billing service to trigger invoices"
        autoComplete="off"
        autoFocus={autoFocus}
        fullWidth
      />
      {tooLong ? (
        <Hint className="text-error">{API_KEY_NOTE_TOO_LONG_MESSAGE}.</Hint>
      ) : (
        <Hint>One line saying what this key is for.</Hint>
      )}
    </InputGroup>
  );
}

/** The note under a key's name in the table: one dimmed line, full text on hover when cut off. */
export function ApiKeyNameCell({
  name,
  note,
  className,
}: {
  name: string;
  note: string | null;
  className?: string;
}) {
  if (!note) return <TruncatedText text={name} className={cn("block", className)} />;

  return (
    <span className={cn("flex flex-col", className)}>
      <TruncatedText text={name} className="block" />
      {/* A step below the name, which the cell dims and brightens on row hover. */}
      <TruncatedText
        text={note}
        tooltip={<span className="block max-w-xs break-words">{note}</span>}
        className="block text-text-faint group-hover/table-row:text-text-dimmed"
      />
    </span>
  );
}

export function EditApiKeyNoteButton({
  id,
  name,
  note,
  canWrite,
  appearance,
}: {
  id: string;
  name: string;
  note: string | null;
  canWrite: boolean;
  /** "menu" for the row menu; "inline" for the small link beside the note in the inspector. */
  appearance: "menu" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(note ?? "");
  const label = note ? "Edit note…" : "Add a note…";
  const noPermission = "You don't have permission to edit API keys";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setValue(note ?? "");
      }}
    >
      <DialogTrigger asChild>
        {appearance === "menu" ? (
          <Button
            {...actionButtonProps("menu")}
            LeadingIcon={PencilIcon}
            leadingIconClassName="text-text-dimmed"
            disabled={!canWrite}
            tooltip={canWrite ? undefined : noPermission}
          >
            {label}
          </Button>
        ) : (
          <Button
            variant="minimal/small"
            LeadingIcon={PencilIcon}
            leadingIconClassName="text-text-dimmed"
            className="shrink-0"
            disabled={!canWrite}
            tooltip={canWrite ? "Edit note" : noPermission}
            aria-label={note ? "Edit note" : "Add a note"}
          >
            {note ? null : "Add a note"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>{note ? "Edit note" : "Add a note"}</DialogHeader>
        <Form method="post" className="flex flex-col gap-4 pt-3" onSubmit={() => setOpen(false)}>
          <input type="hidden" name="action" value="update-description" />
          <input type="hidden" name="apiKeyId" value={id} />
          <Paragraph variant="small">
            The note shows under "{name}" in the list. It doesn't change what the key can do.
          </Paragraph>
          <ApiKeyNoteInput value={value} onChange={setValue} autoFocus />
          <FormButtons
            confirmButton={
              <Button type="submit" variant="primary/medium" disabled={isApiKeyNoteTooLong(value)}>
                {note && !value.trim() ? "Remove note" : "Save"}
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
    </Dialog>
  );
}
