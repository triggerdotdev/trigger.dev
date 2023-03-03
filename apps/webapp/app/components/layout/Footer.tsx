const linkStyle =
  "text-xs font-medium text-slate-400 whitespace-nowrap bg-transparent text-slate-500 transition hover:text-indigo-500";

export function Footer() {
  return (
    <div className="flex w-full flex-col items-center justify-between border-t border-slate-800 bg-slate-950 py-4 pl-2 pr-3 sm:flex-row sm:py-4">
      <div className="flex gap-2 pb-4 text-xs text-slate-500 sm:pb-0">
        <p>&copy; {new Date().getFullYear()} Trigger.dev </p>
        <span className="text-slate-600">|</span>{" "}
        <a
          className="transition hover:text-indigo-500"
          href="https://trigger.dev/legal/terms"
        >
          Terms
        </a>{" "}
        <span className="text-slate-600">|</span>{" "}
        <a
          className="transition hover:text-indigo-500"
          href="https://trigger.dev/legal/privacy"
        >
          Privacy
        </a>
      </div>

      <div className="flex gap-3">
        <a
          target="_blank"
          rel="noopener noreferrer"
          href="https://discord.gg/kA47vcd8P6"
          className={linkStyle}
        >
          Discord
        </a>
        <a
          target="_blank"
          rel="noopener noreferrer"
          href="https://twitter.com/triggerdotdev"
          className={linkStyle}
        >
          Twitter
        </a>

        <a href="mailto:hello@trigger.dev" className={linkStyle}>
          Get in touch
        </a>
      </div>
    </div>
  );
}
