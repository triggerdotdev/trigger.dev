import productHuntLogo from "../assets/images/producthunt.png";
import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { Paragraph } from "./primitives/Paragraph";
import { LinkButton } from "./primitives/Buttons";

export function ProductHuntBanner() {
  return (
    <div className="flex h-8 items-center justify-center gap-2 bg-[#ff6154]">
      <Paragraph variant="small" className="text-white">
        We're live on{" "}
      </Paragraph>
      <img src={productHuntLogo} alt="Product Hunt" className="h-6 w-[122px]" />
      <ArrowRightIcon className="h-4 w-4 text-white" />
      <LinkButton
        to="https://www.producthunt.com/posts/trigger-dev"
        target="_blank"
        className="!text-white underline underline-offset-2 transition hover:decoration-slate-100 hover:decoration-2"
        size="small"
        theme="secondaryOutline"
        children="Vote for us today only!"
      />
    </div>
  );
}
