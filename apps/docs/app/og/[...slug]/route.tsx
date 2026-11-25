import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { navPages } from "@/lib/nav";
import { source } from "@/lib/source";

// One 1200x630 PNG per page at /docs/og/<page path>/image.png, rendered at build time.
export const dynamic = "force-static";
// Only the generated image paths: any other name would render (and cache) a fresh image.
export const dynamicParams = false;

const size = { width: 1200, height: 630 };
const groupOf = new Map(navPages().map((p) => [p.slug, p.group]));

const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const slug = (await params).slug;
  if (slug.at(-1) !== "image.png") notFound();
  const slugs = slug.slice(0, -1);
  const page = source.getPage(slugs);
  if (!page) notFound();
  const group = groupOf.get(slugs.join("/"));
  const title = page.data.title;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "72px 80px",
        backgroundColor: "#121317",
        backgroundImage:
          "radial-gradient(circle at 100% 0%, rgba(168,255,83,0.16), rgba(18,19,23,0) 55%)",
        color: "#d7d9dd",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <img src={await brandLogo()} width={277} height={48} alt="" />
        <div style={{ fontSize: 32, color: "#878c99", marginTop: 4 }}>Docs</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {group && <div style={{ fontSize: 30, color: "#a8ff53", letterSpacing: 0.5 }}>{group}</div>}
        <div
          style={{
            fontSize: title.length > 40 ? 64 : 80,
            lineHeight: 1.08,
            color: "#ffffff",
            letterSpacing: -1.5,
          }}
        >
          {clamp(title, 80)}
        </div>
        {page.data.description && (
          <div style={{ fontSize: 30, lineHeight: 1.4, color: "#a8abb5", maxWidth: 1000 }}>
            {clamp(page.data.description, 150)}
          </div>
        )}
      </div>
    </div>,
    size
  );
}

export function generateStaticParams() {
  return source.getPages().map((p) => ({ slug: [...p.slugs, "image.png"] }));
}

// The brand kit's lockup for dark backgrounds, inlined: ImageResponse can't fetch site-relative URLs.
let logo: Promise<string> | undefined;
function brandLogo() {
  logo ??= readFile(join(process.cwd(), "brand/triggerdev-lockup--light.svg")).then(
    (svg) => `data:image/svg+xml;base64,${svg.toString("base64")}`
  );
  return logo;
}
