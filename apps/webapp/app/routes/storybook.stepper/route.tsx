import { useState } from "react";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { InputNumberStepper } from "~/components/primitives/InputNumberStepper";

export default function Story() {
  const [value1, setValue1] = useState<number | "">(0);
  const [value2, setValue2] = useState<number | "">(100);
  const [value3, setValue3] = useState<number | "">(0);
  const [value4, setValue4] = useState<number | "">(250);
  const [value5, setValue5] = useState<number | "">(250);

  return (
    <div className="grid h-full w-full place-items-center">
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-2">
          <Header2>InputNumberStepper</Header2>
          <Header3>Size: base (default)</Header3>
          <div className="flex flex-col gap-2">
            <label className="text-sm text-text-dimmed">Step: 75</label>
            <InputNumberStepper
              value={value1}
              onChange={(e) => setValue1(e.target.value === "" ? "" : Number(e.target.value))}
              step={75}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-text-dimmed">Step: 50, Min: 0, Max: 1000</label>
            <InputNumberStepper
              value={value2}
              onChange={(e) => setValue2(e.target.value === "" ? "" : Number(e.target.value))}
              step={50}
              min={0}
              max={1000}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-text-dimmed">Disabled state</label>
            <InputNumberStepper
              value={value3}
              onChange={(e) => setValue3(e.target.value === "" ? "" : Number(e.target.value))}
              step={50}
              disabled
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Header3>Size: large</Header3>
          <div className="flex flex-col gap-2">
            <label className="text-sm text-text-dimmed">Step: 50</label>
            <InputNumberStepper
              value={value4}
              onChange={(e) => setValue4(e.target.value === "" ? "" : Number(e.target.value))}
              step={50}
              controlSize="large"
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm text-text-dimmed">Step: 50, Disabled</label>
            <InputNumberStepper
              value={value5}
              onChange={(e) => setValue5(e.target.value === "" ? "" : Number(e.target.value))}
              step={50}
              controlSize="large"
              disabled={true}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
