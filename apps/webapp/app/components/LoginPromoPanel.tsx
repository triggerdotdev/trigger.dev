import {
  EyeIcon,
  BoltIcon,
  BanknotesIcon,
  BugAntIcon,
  BellAlertIcon,
} from "@heroicons/react/24/outline";

export function LoginPromoPanel() {
  return (
    <div className="hidden lg:flex flex-col justify-center p-12 min-w-[30vw] h-full bg-midnight border-r border-white/10">
      <ul>
        <li className="flex gap-2 text-white">
          <div className="flex flex-col items-center gap-2 mt-1.5">
            <EyeIcon className="h-8 w-8 text-toxic" />
            <div className="w-0.5 h-full bg-toxic/50"></div>
          </div>

          <div className="mb-1">
            <h2 className="font-semibold text-2xl">Full observability</h2>
            <p className="mb-10 text-white/80">
              View every single API request and response in real-time from your
              dashboard.
            </p>
          </div>
        </li>
        <li className="flex gap-2 text-white">
          <div className="flex flex-col items-center gap-2 mt-1.5">
            <BoltIcon className="h-8 w-8 text-toxic" />
            <div className="w-0.5 h-full bg-toxic/50"></div>
          </div>

          <div className="mb-1">
            <h2 className="font-semibold text-2xl">Faster responses</h2>
            <p className="mb-10 text-white/80">
              Get less than 10ms response times.
            </p>
          </div>
        </li>
        <li className="flex gap-2 text-white">
          <div className="flex flex-col items-center gap-2 mt-1.5">
            <BanknotesIcon className="h-8 w-8 text-toxic" />
            <div className="w-0.5 h-full bg-toxic/50"></div>
          </div>

          <div className="mb-1">
            <h2 className="font-semibold text-2xl">Save money</h2>
            <p className="mb-10 text-white/80">
              Avoid annoying rate limits by enabling caching – while also saving
              money.
            </p>
          </div>
        </li>
        <li className="flex gap-2 text-white">
          <div className="flex flex-col items-center gap-2 mt-1.5">
            <BugAntIcon className="h-8 w-8 text-toxic" />
            <div className="w-0.5 h-full bg-toxic/50"></div>
          </div>

          <div className="mb-1">
            <h2 className="font-semibold text-2xl">Problem solved</h2>
            <p className="mb-10 text-white/80">
              We deal with CORS issues for you.
            </p>
          </div>
        </li>
        <li className="flex gap-3 text-white">
          <div className="flex flex-col items-center gap-2 mt-1.5">
            <BellAlertIcon className="ml-1.5 h-5 w-5 text-toxic" />
          </div>

          <div className="mb-1">
            <h2 className="font-semibold text-2xl">Automatic alerts</h2>
            <p className="mb-10 text-white/80">
              Get alerts when issues arise and debug them using our inline help
              prompts.
            </p>
          </div>
        </li>
      </ul>
    </div>
  );
}
