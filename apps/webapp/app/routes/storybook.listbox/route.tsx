import { CheckIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Listbox } from "~/components/primitives/Listbox";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";

const people = [
  { id: "1", name: "Durward Reynolds", unavailable: false },
  { id: "2", name: "Kenton Towne", unavailable: false },
  { id: "3", name: "Therese Wunsch", unavailable: false },
  { id: "4", name: "Benedict Kessler", unavailable: true },
  { id: "5", name: "Katelyn Rohan", unavailable: false },
];

export default function Story() {
  const [selectedPersonId, setSelectedPersonId] = useState(people[0].id);

  return (
    <div className="p-20">
      <div className="flex flex-col">
        <Header1 className="mb-4">Variants</Header1>
        <Header2 className="my-4">size=small width=content</Header2>

        <div className="flex gap-8">
          <Listbox.Root value={selectedPersonId} onChange={setSelectedPersonId}>
            <Listbox.Button>{people.find((p) => p.id === selectedPersonId)?.name}</Listbox.Button>
            <Listbox.Options>
              {people.map((person) => (
                <Listbox.Option key={person.id} value={person.id} disabled={person.unavailable}>
                  {({ active, selected }) => (
                    <li className={`${active ? "bg-blue-500 text-white" : "bg-white text-black"}`}>
                      {selected && <CheckIcon />}
                      {person.name}
                    </li>
                  )}
                </Listbox.Option>
              ))}
            </Listbox.Options>
          </Listbox.Root>
          <SelectGroup>
            <Select name="colorScheme" defaultValue="dark">
              <SelectTrigger>
                <SelectValue placeholder="Theme" />
              </SelectTrigger>
              <SelectContent>
                <SelectLabel>Color Scheme</SelectLabel>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="system">System</SelectItem>
                <SelectLabel>Other themes</SelectLabel>
                <SelectItem value="sunset">Sunset</SelectItem>
                <SelectItem value="midnight">Midnight</SelectItem>
                <SelectSeparator />
                <SelectItem value="lunar">Lunar</SelectItem>
              </SelectContent>
            </Select>
          </SelectGroup>
        </div>
      </div>
    </div>
  );
}
