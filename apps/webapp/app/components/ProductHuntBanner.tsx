import { TertiaryA } from "./primitives/Buttons";
import { Body } from "./primitives/text/Body";
import productHuntLogo from "../assets/images/producthunt.png";
import { ArrowRightIcon } from "@heroicons/react/20/solid";

export function ProductHuntBanner() {
  return (
    <div className="flex items-center justify-center gap-2 bg-[#ff6154]">
      <Body size="small" className="text-white">
        We're live on{" "}
      </Body>
      <img src={productHuntLogo} alt="Product Hunt" className="h-6 w-[122px]" />
      <ArrowRightIcon className="h-4 w-4 text-white" />
      <TertiaryA
        href="https://www.producthunt.com/posts/trigger-dev"
        target="_blank"
        className="!text-white underline underline-offset-2 transition hover:decoration-slate-100 hover:decoration-2"
      >
        Vote for us today only!
      </TertiaryA>
    </div>
  );
}
