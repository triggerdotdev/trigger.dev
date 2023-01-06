import {
  EyeIcon,
  BoltIcon,
  BanknotesIcon,
  BellAlertIcon,
  WrenchScrewdriverIcon,
  BeakerIcon,
  CloudArrowUpIcon,
} from "@heroicons/react/24/outline";

export function LoginPromoPanel() {
  return (
    <div className="hidden lg:flex flex-col justify-center p-12 max-w-[30vw] h-full bg-slate-950 border-r border-black/20">
      <ul>
        <li className="flex gap-2 text-white">
          <div className="flex flex-col items-center gap-2 mt-1.5">
            <WrenchScrewdriverIcon className="h-8 w-8 text-toxic" />
            <div className="w-0.5 h-full bg-toxic/50"></div>
          </div>

          <div className="mb-1">
            <h2 className="font-semibold text-2xl mb-2">Create</h2>
            <p className="mb-10 text-white/60">
              Write workflows by creating triggers directly in your code. These
              can be 3rd-party integrations, custom events or on a schedule.
            </p>
          </div>
        </li>
        <li className="flex gap-2 text-white">
          <div className="flex flex-col items-center gap-2 mt-1.5">
            <BoltIcon className="h-8 w-8 text-toxic" />
            <div className="w-0.5 h-full bg-toxic/50"></div>
          </div>

          <div className="mb-1">
            <h2 className="font-semibold text-2xl mb-2">Run</h2>
            <p className="mb-10 text-white/60">
              When your server runs, your workflow will be registered and you
              can authenticate with any APIs you’re using.
            </p>
          </div>
        </li>
        <li className="flex gap-2 text-white">
          <div className="flex flex-col items-center gap-2 mt-1.5">
            <BeakerIcon className="h-8 w-8 text-toxic" />
            <div className="w-0.5 h-full bg-toxic/50"></div>
          </div>
          <div className="mb-1">
            <h2 className="font-semibold text-2xl mb-2">Test</h2>
            <p className="mb-10 text-white/60">
              Test your workflow by triggering them manually in your dashboard.
              Follow it as it runs step-by-step.
            </p>
          </div>
        </li>

        <li className="flex gap-3 text-white">
          <div className="flex flex-col items-center gap-2 mt-1.5">
            <CloudArrowUpIcon className="ml-0.5 h-7 w-7 text-toxic" />
          </div>

          <div className="mb-1">
            <h2 className="font-semibold text-2xl mb-2">Deploy</h2>
            <p className="mb-10 text-white/60">
              Deploy your new workflow as you would any other code commit and
              inspect each workflow run in real time.
            </p>
          </div>
        </li>
      </ul>
    </div>
  );
}
