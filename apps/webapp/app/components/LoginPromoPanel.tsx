import {
  BeakerIcon,
  BoltIcon,
  CloudArrowUpIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import { TemplateListItem } from "~/presenters/templateListPresenter.server";
import { TemplateCard } from "./templates/TemplateCard";

export function LoginPromoPanel({ template }: { template?: TemplateListItem }) {
  return (
    <div className="hidden h-full max-w-[30vw] flex-col justify-center border-r border-black/20 bg-slate-950 p-12 lg:flex">
      {template ? (
        <TemplateCard template={template} />
      ) : (
        <ul>
          <li className="flex gap-2 text-white">
            <div className="mt-1.5 flex flex-col items-center gap-2">
              <WrenchScrewdriverIcon className="text-toxic h-8 w-8" />
              <div className="bg-toxic/50 h-full w-0.5"></div>
            </div>

            <div className="mb-1">
              <h2 className="mb-2 text-2xl font-semibold">Create</h2>
              <p className="mb-10 text-white/60">
                Write workflows by creating triggers directly in your code.
                These can be 3rd-party integrations, custom events or on a
                schedule.
              </p>
            </div>
          </li>
          <li className="flex gap-2 text-white">
            <div className="mt-1.5 flex flex-col items-center gap-2">
              <BoltIcon className="text-toxic h-8 w-8" />
              <div className="bg-toxic/50 h-full w-0.5"></div>
            </div>

            <div className="mb-1">
              <h2 className="mb-2 text-2xl font-semibold">Run</h2>
              <p className="mb-10 text-white/60">
                When your server runs, your workflow will be registered and you
                can authenticate with any APIs you’re using.
              </p>
            </div>
          </li>
          <li className="flex gap-2 text-white">
            <div className="mt-1.5 flex flex-col items-center gap-2">
              <BeakerIcon className="text-toxic h-8 w-8" />
              <div className="bg-toxic/50 h-full w-0.5"></div>
            </div>
            <div className="mb-1">
              <h2 className="mb-2 text-2xl font-semibold">Test</h2>
              <p className="mb-10 text-white/60">
                Test your workflow by triggering them manually in your
                dashboard. Follow it as it runs step-by-step.
              </p>
            </div>
          </li>

          <li className="flex gap-3 text-white">
            <div className="mt-1.5 flex flex-col items-center gap-2">
              <CloudArrowUpIcon className="text-toxic ml-0.5 h-7 w-7" />
            </div>

            <div className="mb-1">
              <h2 className="mb-2 text-2xl font-semibold">Deploy</h2>
              <p className="mb-10 text-white/60">
                Deploy your new workflow as you would any other code commit and
                inspect each workflow run in real time.
              </p>
            </div>
          </li>
        </ul>
      )}
    </div>
  );
}
