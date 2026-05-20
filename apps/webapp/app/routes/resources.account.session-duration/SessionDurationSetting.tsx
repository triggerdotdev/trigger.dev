import { useSubmit } from "@remix-run/react";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Select, SelectItem } from "~/components/primitives/Select";
import type { SessionDurationOption } from "~/services/sessionDuration.server";

interface SessionDurationSettingProps {
  currentValue: number;
  options: SessionDurationOption[];
  orgCapSeconds: number | null;
}

export function SessionDurationSetting({
  currentValue,
  options,
  orgCapSeconds,
}: SessionDurationSettingProps) {
  const submit = useSubmit();

  const orgCapOption =
    orgCapSeconds === null ? null : options.find((o) => o.value === orgCapSeconds);

  return (
    <div className="w-full">
      <div className="flex w-full items-center justify-between gap-4">
        <InputGroup className="flex-1">
          <Label>Automatic logout</Label>
          <Paragraph variant="small">
            Automatically log out after a period of time.
            {orgCapSeconds !== null ? (
              <>
                {" "}
                Your organization caps this at {orgCapOption?.label ?? `${orgCapSeconds} seconds`}.
              </>
            ) : null}
          </Paragraph>
        </InputGroup>
        <div className="flex flex-none items-center">
          <Select
            name="sessionDuration"
            variant="secondary/small"
            defaultValue={String(currentValue)}
            setValue={(value) => {
              const next = Array.isArray(value) ? value[0] : value;
              if (typeof next !== "string" || next === String(currentValue)) return;
              submit(
                { sessionDuration: next },
                { method: "post", action: "/resources/account/session-duration" }
              );
            }}
            text={(value: string) =>
              options.find((o) => String(o.value) === value)?.label ?? "Select a duration"
            }
            dropdownIcon
          >
            {options.map((option) => (
              <SelectItem
                key={option.value}
                value={String(option.value)}
                className="text-text-bright"
              >
                {option.label}
              </SelectItem>
            ))}
          </Select>
        </div>
      </div>
    </div>
  );
}
