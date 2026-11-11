import { GlobeAltIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import { Form } from "@remix-run/react";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { FormButtons } from "~/components/primitives/FormButtons";
import { Hint } from "~/components/primitives/Hint";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextArea } from "~/components/primitives/TextArea";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TruncatedText } from "~/components/primitives/TruncatedText";
import { type ActionAppearance, actionButtonProps } from "./ApiKeyActions";

export const IP_RANGES_FIELD = "allowedIpRanges";

/** Split the IP ranges textarea into entries; any whitespace or comma separates them. */
export function splitIpRangesInput(value: FormDataEntryValue | null | undefined): string[] {
  if (typeof value !== "string") return [];
  return value.split(/[\s,]+/).filter(Boolean);
}

// Whether an allowlist entry already covers `ip`, to hide the "Add this IP" shortcut. IPv4
// ranges are checked properly; IPv6 entries only match the exact address. The server does the
// real matching, so a miss here only means the shortcut shows when it isn't needed.
function entryCoversIp(entry: string, ip: string): boolean {
  const [address = "", prefixText] = entry.split("/");
  const ipValue = ipv4ToNumber(ip);
  const base = ipv4ToNumber(address);

  if (ipValue === null || base === null) {
    return (
      address.toLowerCase() === ip.toLowerCase() &&
      (prefixText === undefined || prefixText === "128")
    );
  }

  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const blockSize = 2 ** (32 - prefix);
  return Math.floor(base / blockSize) === Math.floor(ipValue / blockSize);
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

const IP_RANGES_HINT = "One IP address or CIDR range per line. Leave empty to allow any IP.";

export function ApiKeyIpRangesField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <InputGroup fullWidth>
      <Label htmlFor="api-key-ip-ranges">Allowed IP addresses</Label>
      <TextArea
        id="api-key-ip-ranges"
        name={IP_RANGES_FIELD}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        placeholder="Any IP"
        spellCheck={false}
        className="py-2 font-mono"
      />
      <Hint>{IP_RANGES_HINT}</Hint>
    </InputGroup>
  );
}

export function ApiKeyAllowedIps({ ranges }: { ranges: string[] }) {
  // No colours of its own: the cell dims it and brightens it on row hover, like the other data.
  if (ranges.length === 0) {
    return <span className="text-xs">Any IP</span>;
  }

  // One line: a long range (IPv6) truncates, and the count of the rest stays at the end.
  const label = (
    <span className="flex max-w-[13rem] items-center gap-1 text-xs">
      {/* With more ranges, the cell's tooltip already lists them all in full. */}
      {ranges.length > 1 ? (
        <span className="min-w-0 truncate font-mono">{ranges[0]}</span>
      ) : (
        <TruncatedText text={ranges[0]} className="min-w-0 font-mono" />
      )}
      {ranges.length > 1 ? <span className="shrink-0">+{ranges.length - 1} more</span> : null}
    </span>
  );

  if (ranges.length === 1) return label;

  return (
    // asChild: the label is the trigger, so there's no button inside the row's link.
    <SimpleTooltip
      asChild
      button={label}
      disableHoverableContent
      content={
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {ranges.map((range) => (
            <li key={range}>{range}</li>
          ))}
        </ul>
      }
    />
  );
}

export function ApiKeyLastUsed({
  lastUsedAt,
  lastUsedIp,
}: {
  lastUsedAt: Date | string | null;
  lastUsedIp: string | null;
}) {
  if (!lastUsedAt) return <>Never</>;

  // One line: the date never truncates; the IP follows it and truncates if it's a long IPv6.
  return (
    <span className="flex max-w-[16rem] items-center gap-1.5">
      <span className="shrink-0">
        <DateTime date={lastUsedAt} includeSeconds={false} />
      </span>
      {lastUsedIp ? (
        <TruncatedText text={lastUsedIp} className="min-w-0 font-mono text-xs" />
      ) : null}
    </span>
  );
}

export function EditApiKeyIpRangesButton({
  id,
  name,
  ranges,
  lastUsedIp,
  canWrite,
  appearance = "menu",
}: {
  id: string;
  name: string;
  ranges: string[];
  lastUsedIp: string | null;
  canWrite: boolean;
  appearance?: ActionAppearance;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(ranges.join("\n"));
  const entries = splitIpRangesInput(value);
  const lastUsedIpListed =
    lastUsedIp !== null && entries.some((entry) => entryCoversIp(entry, lastUsedIp));

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setValue(ranges.join("\n"));
      }}
    >
      <DialogTrigger asChild>
        <Button
          {...actionButtonProps(appearance)}
          LeadingIcon={GlobeAltIcon}
          leadingIconClassName="text-text-dimmed"
          disabled={!canWrite}
          tooltip={canWrite ? undefined : "You don't have permission to edit API keys"}
        >
          Edit allowed IPs…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>Allowed IP addresses</DialogHeader>
        <Form method="post" className="flex flex-col gap-4 pt-3" onSubmit={() => setOpen(false)}>
          <input type="hidden" name="action" value="update-ip-ranges" />
          <input type="hidden" name="apiKeyId" value={id} />
          <Paragraph variant="small">
            Requests using "{name}" from any other IP address are rejected. Changes take effect
            immediately.
          </Paragraph>
          <ApiKeyIpRangesField value={value} onChange={setValue} />
          {lastUsedIp ? (
            <div className="flex items-center justify-between gap-2">
              <Paragraph variant="small">
                Last used from <span className="font-mono text-text-bright">{lastUsedIp}</span>
              </Paragraph>
              {lastUsedIpListed ? null : (
                <Button
                  type="button"
                  variant="secondary/small"
                  onClick={() =>
                    setValue(value.trim() ? `${value.trim()}\n${lastUsedIp}` : lastUsedIp)
                  }
                >
                  Add this IP
                </Button>
              )}
            </div>
          ) : null}
          <FormButtons
            confirmButton={
              <Button type="submit" variant="primary/medium">
                Save
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
