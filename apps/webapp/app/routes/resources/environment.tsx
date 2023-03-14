import { Popover, Transition } from "@headlessui/react";
import { ChevronUpDownIcon } from "@heroicons/react/24/outline";
import { CheckIcon } from "@heroicons/react/24/solid";
import { useFetcher } from "@remix-run/react";
import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import classNames from "classnames";
import { Fragment } from "react";
import { z } from "zod";
import {
  useCurrentEnvironment,
  useEnvironments,
} from "~/hooks/useEnvironments";
import { commitSession, getSession } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { titleCase } from "~/utils";
import { BreadcrumbDivider } from "../../components/layout/Header";

const requestSchema = z.object({
  environment: z.string().min(1),
});

const ONE_YEAR = 1000 * 60 * 60 * 24 * 365;

export const action = async ({ request }: ActionArgs) => {
  const userId = await requireUserId(request);
  if (userId === null) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const formData = await request.formData();
    const body = Object.fromEntries(formData.entries());
    const { environment } = requestSchema.parse(body);

    const session = await getSession(request.headers.get("cookie"));
    session.set("environment", environment);

    return json(
      { success: true },
      {
        headers: {
          "Set-Cookie": await commitSession(session, {
            expires: new Date(Date.now() + ONE_YEAR),
          }),
        },
      }
    );
  } catch (error: any) {
    throw new Response(error.message, { status: 400 });
  }
};

export function EnvironmentMenu() {
  const fetcher = useFetcher();
  const environments = useEnvironments();
  const currentEnvironment = useCurrentEnvironment();

  if (environments === undefined || currentEnvironment === undefined) {
    return <></>;
  }

  return (
    <>
      <fetcher.Form
        className="w-full"
        action="/resources/environment"
        method="post"
      >
        <Popover className="relative">
          {({ open }) => (
            <>
              <Popover.Button
                className={classNames(
                  currentEnvironment.slug === "live"
                    ? "bg-orange-500/10 hover:bg-orange-500/30"
                    : "bg-emerald-500/20 hover:bg-emerald-500/10",
                  "flex w-full items-center justify-between gap-2 rounded py-2 pl-3.5 pr-2 text-base text-slate-300 transition focus:outline-none"
                )}
              >
                <div className="flex items-center gap-2">
                  <EnvironmentIcon slug={currentEnvironment.slug} />
                  <span className="transition">
                    {currentEnvironment ? (
                      <span>{titleCase(currentEnvironment.slug)}</span>
                    ) : (
                      <span className="">Select environment</span>
                    )}
                  </span>
                </div>
                <ChevronUpDownIcon
                  className={`${open ? "" : ""}
                  ml-1 h-5 w-5 text-slate-300 transition duration-150 ease-in-out`}
                  aria-hidden="true"
                />
              </Popover.Button>
              <Transition
                as={Fragment}
                enter="transition ease-out duration-200"
                enterFrom="opacity-0 translate-y-1"
                enterTo="opacity-100 translate-y-0"
                leave="transition ease-in duration-150"
                leaveFrom="opacity-100 translate-y-0"
                leaveTo="opacity-0 translate-y-1"
              >
                <Popover.Panel className="absolute left-0 z-50 mt-2 w-screen min-w-[15rem] max-w-[15rem] translate-x-0 transform px-4 sm:px-0">
                  <div className="overflow-hidden rounded-lg shadow-lg ring-1 ring-black ring-opacity-5">
                    <div className="relative grid grid-cols-1 gap-y-1 bg-slate-700 py-1">
                      {environments.map((environment) => {
                        return (
                          <Popover.Button
                            key={environment.id}
                            as="button"
                            type="submit"
                            name="environment"
                            value={environment.slug}
                            className={classNames(
                              "mx-1 flex items-center justify-between gap-1.5 rounded px-3 py-2 text-white transition hover:bg-slate-800",
                              environment.slug === currentEnvironment?.slug &&
                                "!bg-slate-800"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <EnvironmentIcon slug={environment.slug} />
                              <span className="block truncate">
                                {titleCase(environment.slug)}
                              </span>
                            </div>
                            {environment.slug === currentEnvironment?.slug && (
                              <CheckIcon className="h-5 w-5 text-blue-600" />
                            )}
                          </Popover.Button>
                        );
                      })}
                    </div>
                  </div>
                </Popover.Panel>
              </Transition>
            </>
          )}
        </Popover>
      </fetcher.Form>
    </>
  );
}

export function EnvironmentIcon({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  let color = "bg-emerald-500";
  if (slug === "live") {
    color = "bg-orange-500";
  }
  return (
    <span
      className={classNames(
        "block  h-[0.35rem] w-[0.35rem] rounded-full",
        color,
        className
      )}
    />
  );
}
