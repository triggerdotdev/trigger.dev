import { Header1, Header2 } from "~/components/primitives/Headers";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/OldSelect";

export default function Story() {
  return (
    <div className="p-20">
      <div className="flex flex-col">
        <Header1 className="mb-4">Variants</Header1>
        <Header2 className="my-4">size=small width=content</Header2>
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
        <Header2 className="my-4">size=small width=full</Header2>
        <SelectGroup>
          <Select name="colorScheme" defaultValue="dark">
            <SelectTrigger width="full">
              <SelectValue placeholder="Theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="sunset">Sunset</SelectItem>
              <SelectItem value="midnight">Midnight</SelectItem>
              <SelectSeparator />
              <SelectItem value="lunar">Lunar</SelectItem>
            </SelectContent>
          </Select>
        </SelectGroup>
        <Header2 className="my-4">size=medium width=content</Header2>
        <SelectGroup>
          <Select name="colorScheme" defaultValue="dark">
            <SelectTrigger size="medium">
              <SelectValue placeholder="Theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="sunset">Sunset</SelectItem>
              <SelectItem value="midnight">Midnight</SelectItem>
              <SelectSeparator />
              <SelectItem value="lunar">Lunar</SelectItem>
            </SelectContent>
          </Select>
        </SelectGroup>
        <Header2 className="my-4">size=medium width=full</Header2>
        <SelectGroup>
          <Select name="colorScheme" defaultValue="dark">
            <SelectTrigger size="medium" width="full">
              <SelectValue placeholder="Theme" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="sunset">Sunset</SelectItem>
              <SelectItem value="midnight">Midnight</SelectItem>
              <SelectSeparator />
              <SelectItem value="lunar">Lunar</SelectItem>
            </SelectContent>
          </Select>
        </SelectGroup>
      </div>
    </div>
  );
}
