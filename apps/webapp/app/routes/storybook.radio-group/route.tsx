import { useState } from "react";
import { OneTreeIcon } from "~/assets/icons/OneTreeIcon";
import { Button } from "~/components/primitives/Buttons";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";

export default function Story() {
  const [isDisabled, setIsDisabled] = useState(false);

  return (
    <div className="flex flex-col items-start gap-y-8 p-8">
      <Button
        onClick={() => setIsDisabled((d) => !d)}
        variant="primary/medium"
        className="max-w-fit"
      >
        {isDisabled ? "Enable" : "Disable"}
      </Button>
      <form>
        <RadioGroup name="simple" disabled={isDisabled} className="grid gap-2">
          <RadioGroupItem id="r2" label="Simple small" value={"1"} variant="simple/small" />
          <RadioGroupItem id="r3" label="Simple" value={"2"} variant="simple" />
          <RadioGroupItem id="r4" label="Button small" value={"3"} variant="button/small" />
          <RadioGroupItem id="r5" label="Button" value={"4"} variant="button" />
          <RadioGroupItem
            id="r6"
            label="This is a label"
            description="This is a description"
            value={"5"}
            variant="description"
          />
          <RadioGroupItem
            id="r7"
            label="This is an icon label"
            description="This is a description"
            value={"6"}
            variant="icon"
            icon={<OneTreeIcon className="h-8 w-8 text-green-500" />}
          />
          <RadioGroupItem
            id="r8"
            label={
              <div className="flex items-center gap-2">
                <span>This is a</span> <span className="text-red-500">React node</span>
              </div>
            }
            value={"8"}
            variant="simple/small"
          />
        </RadioGroup>
      </form>
    </div>
  );
}
