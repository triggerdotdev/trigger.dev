import { TertiaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";

export function ImpersonationBanner() {
  return (
    <div className="grid grid-cols-3 items-center bg-gradient-to-r from-amber-500 via-amber-400 to-amber-500 text-center px-4">
      <span></span>
      <Body size="small" className="text-slate-800">
        You are impersonating{" "}
        <span className="font-semibold">James Ritchie</span>
      </Body>
      <TertiaryA
        href="/api/auth/logout"
        className="justify-self-end text-slate-700 hover:!text-slate-900"
      >
        Stop impersonating
      </TertiaryA>
    </div>
  );
}
