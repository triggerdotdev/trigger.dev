import { LoadingBarDivider } from "~/components/primitives/LoadingBarDivider";

const isLoading = true;

export default function Story() {
  return (
    <div className="grid h-full w-full max-w-3xl place-items-center px-20">
      <LoadingBarDivider isLoading={isLoading} />
    </div>
  );
}
