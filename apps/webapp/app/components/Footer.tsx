import { Link } from "@remix-run/react";

export function Footer() {
  const linkStyle =
    "bg-slate-100 text-xs font-medium text-slate-700  whitespace-nowrap p-0 px-3 py-1 bg-transparent text-slate-500 transition hover:text-blue-500 hover:underline";

  return (
    <div className="flex w-full items-center justify-between border-t border-gray-200 bg-white px-2 flex-row gap-0 py-1">
      <p className="text-xs text-slate-500">
        &copy; Trigger.dev 2022 <span className="text-slate-300">|</span>{" "}
        <Link className="transition hover:text-blue-500" to="/legal/terms">
          Terms
        </Link>{" "}
        <span className="text-slate-300">|</span>{" "}
        <Link className="transition hover:text-blue-500" to="/legal/privacy">
          Privacy
        </Link>
      </p>

      <div className="flex items-center gap-6">
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
          href="https://twitter.com/runapihero"
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
