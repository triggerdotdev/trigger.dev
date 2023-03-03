import { Popover, Transition } from "@headlessui/react";
import { Link, NavLink } from "@remix-run/react";
import { Fragment } from "react";
import { Logo } from "../Logo";
import { PrimaryLink, ToxicLink } from "../primitives/Buttons";
import { MobileNavIcon, MobileNavLink } from "../primitives/NavLink";

function MobileNavigation() {
  return (
    <Popover>
      <Popover.Button
        className="bg-slate-70 relative z-10 flex h-8 w-8 items-center justify-center rounded-md border-none bg-opacity-50 focus:border-none [&:not(:focus-visible)]:focus:outline-none"
        aria-label="Toggle Navigation"
      >
        {({ open }) => <MobileNavIcon open={open} />}
      </Popover.Button>
      <Transition.Root>
        <Transition.Child
          as={Fragment}
          enter="duration-150 ease-out"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="duration-150 ease-in"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <Popover.Overlay className="absolute inset-x-6 top-full mt-4 flex origin-top flex-col gap-2 rounded-2xl bg-slate-600 p-6 text-lg tracking-tight text-slate-900 shadow-xl ring-1 ring-slate-900/5" />
        </Transition.Child>
        <Transition.Child
          as={Fragment}
          enter="duration-150 ease-out"
          enterFrom="opacity-0 scale-95"
          enterTo="opacity-100 scale-100"
          leave="duration-100 ease-in"
          leaveFrom="opacity-100 scale-100"
          leaveTo="opacity-0 scale-95"
        >
          <Popover.Panel
            as="div"
            className="absolute inset-x-6 top-full mt-4 flex origin-top flex-col gap-4 rounded-2xl bg-slate-800 p-6 text-lg tracking-tight text-slate-900 shadow-xl ring-1 ring-slate-700"
          >
            <PrimaryLink
              className="w-full !max-w-none whitespace-nowrap text-base"
              to="https://app.trigger.dev"
            >
              Sign up
            </PrimaryLink>
            <MobileNavLink
              className="whitespace-nowrap text-base"
              to="https://docs.trigger.dev"
              target="_blank"
            >
              Docs
            </MobileNavLink>

            <MobileNavLink
              className="whitespace-nowrap text-base"
              to="https://docs.trigger.dev/examples/examples"
              target="_blank"
            >
              Examples
            </MobileNavLink>
            <MobileNavLink to="/pricing" title="Pricing">
              Pricing
            </MobileNavLink>
            <MobileNavLink
              to="https://github.com/triggerdotdev/trigger.dev"
              target="_blank"
            >
              GitHub
            </MobileNavLink>
            <MobileNavLink to="https://app.trigger.dev">Login</MobileNavLink>
          </Popover.Panel>
        </Transition.Child>
      </Transition.Root>
    </Popover>
  );
}

export function MarketingHeader() {
  return (
    <>
      <header className="sticky top-0 z-50 w-full bg-slate-900">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-6 sm:px-10 lg:px-16 ">
          <div className="flex items-center gap-x-6 md:gap-x-[56px]">
            <a
              href="https://trigger.dev"
              target="_self"
              rel="noreferrer"
              className="w-[160px]"
            >
              <Logo className="h-full" />
            </a>
            <div className="hidden gap-x-4 font-semibold md:flex md:gap-x-4 lg:gap-x-10">
              <a
                href="https://docs.trigger.dev/"
                title="Docs"
                aria-label="Docs"
                target="_blank"
                className="transform text-slate-200 hover:text-toxic-500"
                rel="noreferrer"
              >
                Docs
              </a>

              <NavLink
                to="/templates"
                title="Templates"
                aria-label="Templates"
                className="transform text-slate-200 hover:text-toxic-500"
              >
                Templates
              </NavLink>
              <a
                href="https://trigger.dev/pricing"
                title="Pricing"
                aria-label="Pricing"
                className="transform text-slate-200 hover:text-toxic-500"
              >
                Pricing
              </a>
            </div>
          </div>
          <div className="flex items-center justify-center gap-x-4 md:gap-x-4 lg:gap-x-6">
            <a
              href="https://github.com/triggerdotdev/trigger.dev"
              rel="noreferrer"
              aria-label="Trigger.dev GitHub"
              target="_blank"
              title="Trigger.dev GitHub"
              className="hidden items-center text-right text-xs text-slate-500 transition hover:text-toxic-500 md:flex"
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M11.9906 1.78809C6.19453 1.78574 1.5 6.47793 1.5 12.2693C1.5 16.849 4.43672 20.742 8.52656 22.1717C9.07734 22.31 8.99297 21.9186 8.99297 21.6514V19.835C5.8125 20.2076 5.68359 18.1029 5.47031 17.7514C5.03906 17.0154 4.01953 16.8279 4.32422 16.4764C5.04844 16.1037 5.78672 16.5701 6.64219 17.8334C7.26094 18.7498 8.46797 18.5951 9.07969 18.4428C9.21328 17.892 9.49922 17.3998 9.89297 17.0178C6.59766 16.4271 5.22422 14.4162 5.22422 12.0256C5.22422 10.8654 5.60625 9.79902 6.35625 8.93887C5.87812 7.5209 6.40078 6.30684 6.47109 6.12637C7.83281 6.00449 9.24844 7.10137 9.35859 7.18809C10.132 6.97949 11.0156 6.86934 12.0047 6.86934C12.9984 6.86934 13.8844 6.98418 14.6648 7.19512C14.9297 6.99355 16.2422 6.05137 17.5078 6.16621C17.5758 6.34668 18.0867 7.53262 17.6367 8.93184C18.3961 9.79434 18.7828 10.8701 18.7828 12.0326C18.7828 14.4279 17.4 16.4412 14.0953 17.0225C14.3784 17.3008 14.6031 17.6328 14.7564 17.999C14.9098 18.3652 14.9886 18.7583 14.9883 19.1553V21.792C15.007 22.0029 14.9883 22.2115 15.3398 22.2115C19.4906 20.8123 22.4789 16.8912 22.4789 12.2717C22.4789 6.47793 17.782 1.78809 11.9906 1.78809V1.78809Z"
                  fill="currentColor"
                ></path>
              </svg>
            </a>
            <NavLink
              to="/login"
              title="Login"
              aria-label="Login"
              className="hidden transform font-semibold text-slate-200 hover:text-toxic-500 md:flex"
            >
              Login
            </NavLink>

            <ToxicLink className="font-lg whitespace-nowrap " to="/login">
              Sign up
            </ToxicLink>

            <div className="-mr-1 md:hidden">
              <MobileNavigation />
            </div>
          </div>
        </nav>
      </header>
    </>
  );
}
