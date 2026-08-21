import { ComponentNames } from "../storybook/StoryKit";
import { LoadingBarDivider } from "~/components/primitives/LoadingBarDivider";

const isLoading = true;

export default function Story() {
  return (
    <div className="grid h-full w-full max-w-3xl place-items-center px-20">
      <div className="px-4 pt-4">
        <ComponentNames names={["LoadingBarDivider.tsx"]} />
      </div>
      <LoadingBarDivider isLoading={isLoading} />
    </div>
  );
}
