export function Footer() {
  const linkStyle =
    "text-xs font-medium text-slate-400 whitespace-nowrap bg-transparent text-slate-500 transition hover:text-indigo-500";

  return (
    <div className="flex w-full items-center justify-between border-t border-slate-800 bg-slate-950 pl-2 pr-3 py-1 flex-row gap-0">
      <p className="text-xs text-slate-500">
        &copy; {new Date().getFullYear()} Trigger.dev{" "}
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
      </p>

      <div className="flex">
        {/* <a
          target="_blank"
          rel="noopener noreferrer"
          href="https://discord.com/channels/946768798457921646/1020286418343448586"
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
        </a> */}

        <a href="mailto:hello@trigger.dev" className={linkStyle}>
          Get in touch
        </a>
      </div>
    </div>
  );
}
