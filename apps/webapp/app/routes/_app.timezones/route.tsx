import { Link } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { LogoIcon } from "~/components/LogoIcon";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { getTimezones } from "~/utils/timezones.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return typedjson({
    timezones: getTimezones(),
  });
};

export default function Page() {
  const { timezones } = useTypedLoaderData<typeof loader>();
  return (
    <div className="grid grid-rows-[2.5rem_1fr]">
      <div className="flex items-center border-b border-b-grid-dimmed px-3">
        <Link to="/">
          <LogoIcon className="relative -top-px mr-2 h-4 w-4 min-w-4" />
        </Link>
      </div>
      <div className="overflow-y-auto p-8 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        <Header1 spacing>Supported timezones</Header1>
        <Paragraph spacing>We support these timezones when creating a schedule.</Paragraph>
        <ul className="">
          {timezones.map((timezone) => (
            <li key={timezone}>{timezone}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
