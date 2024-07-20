import tagLeftPath from "./tag-left.svg";

type Tag = string;

export function RunTag({ tag }: { tag: Tag }) {
  return (
    <span className="flex h-6 items-stretch">
      <img src={tagLeftPath} alt="" className="block h-full w-[0.5625rem]" />
      <span className="flex items-center rounded-r-sm border-y border-r border-charcoal-700 bg-charcoal-800 pr-1.5 text-text-dimmed">
        {tag}
      </span>
    </span>
  );
}
