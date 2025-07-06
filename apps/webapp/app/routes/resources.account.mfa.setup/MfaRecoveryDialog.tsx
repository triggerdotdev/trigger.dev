import { Form } from "@remix-run/react";
import { DownloadIcon } from "lucide-react";
import { Button } from "~/components/primitives/Buttons";
import { CopyButton } from "~/components/primitives/CopyButton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/primitives/Dialog";
import { Paragraph } from "~/components/primitives/Paragraph";

interface MfaRecoveryDialogProps {
  isOpen: boolean;
  recoveryCodes?: string[];
  onSave: () => void;
}

export function MfaRecoveryDialog({
  isOpen,
  recoveryCodes,
  onSave,
}: MfaRecoveryDialogProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave();
  };

  const downloadRecoveryCodes = () => {
    if (!recoveryCodes) return;
    
    const content = recoveryCodes.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trigger-dev-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!recoveryCodes) return null;

  return (
    <Dialog open={isOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Recovery codes</DialogTitle>
        </DialogHeader>
        <Form method="post" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2 pb-0 pt-3">
            <Paragraph spacing>
              Copy and store these recovery codes carefully in case you lose your device.
            </Paragraph>

            <div className="flex flex-col gap-6 rounded border border-grid-dimmed bg-background-bright pt-6">
              <div className="grid grid-cols-3 gap-2">
                {recoveryCodes.map((code, index) => (
                  <div key={index} className="text-center font-mono text-sm text-text-bright">
                    {code}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-end border-t border-grid-bright px-1.5 py-1.5">
                <Button
                  type="button"
                  variant="minimal/medium"
                  onClick={downloadRecoveryCodes}
                  LeadingIcon={DownloadIcon}
                >
                  Download
                </Button>
                <CopyButton
                  value={recoveryCodes.join("\n")}
                  buttonVariant="minimal"
                  showTooltip={false}
                >
                  Copy
                </CopyButton>
              </div>
            </div>
          </div>

          <DialogFooter className="justify-end border-t-0">
            <Button
              type="submit"
              variant="primary/medium"
              shortcut={{ key: "Enter" }}
              hideShortcutKey
              autoFocus
            >
              Continue
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}