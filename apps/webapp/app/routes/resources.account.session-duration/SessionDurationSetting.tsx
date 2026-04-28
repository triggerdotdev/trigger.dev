import { Form, useNavigation } from "@remix-run/react";
import { Button } from "~/components/primitives/Buttons";
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
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state !== "idle" &&
    navigation.formAction === "/resources/account/session-duration";

  const orgCapOption =
    orgCapSeconds === null ? null : options.find((o) => o.value === orgCapSeconds);

  return (
    <Form method="post" action="/resources/account/session-duration" className="w-full">
      <InputGroup className="mb-4">
        <Label>Automatic logout</Label>
        <Paragraph variant="small">
          Automatically log out after this period of time. Choose a shorter duration for added
          security on shared or unattended devices.
          {orgCapSeconds !== null ? (
            <>
              {" "}
              Your organization caps this at {orgCapOption?.label ?? `${orgCapSeconds} seconds`}.
            </>
          ) : null}
        </Paragraph>
      </InputGroup>
      <div className="flex items-center gap-2">
        <Select
          name="sessionDuration"
          variant="tertiary/medium"
          defaultValue={String(currentValue)}
          text={(value: string) =>
            options.find((o) => String(o.value) === value)?.label ?? "Select a duration"
          }
          dropdownIcon
        >
          {options.map((option) => (
            <SelectItem key={option.value} value={String(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </Select>
        <Button
          type="submit"
          variant="primary/medium"
          disabled={isSubmitting}
          data-action="save session duration"
        >
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
      </div>
    </Form>
  );
}
