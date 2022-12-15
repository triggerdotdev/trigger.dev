import { Link } from "@remix-run/react";

export function Footer() {
  const linkStyle =
    "bg-slate-100 text-xs font-medium text-slate-700 whitespace-nowrap bg-transparent text-slate-500 transition hover:text-blue-500";

  return (
    <div className="flex w-full items-center justify-between border-t border-slate-800 bg-slate-1000 pl-2 pr-3 py-1 flex-row gap-0">
      <p className="text-xs text-slate-500">
        &copy; {new Date().getFullYear()} Trigger.dev{" "}
        <span className="text-slate-600">|</span>{" "}
        <Link className="transition hover:text-blue-500" to="/legal/terms">
          Terms
        </Link>{" "}
        <span className="text-slate-600">|</span>{" "}
        <Link className="transition hover:text-blue-500" to="/legal/privacy">
          Privacy
        </Link>
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
