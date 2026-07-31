import { useEffect, useRef, useState } from "react";
import { Button, type ButtonVariant } from "~/components/primitives/Buttons";
import {
  ClientTabs,
  ClientTabsContent,
  ClientTabsList,
  ClientTabsTrigger,
} from "~/components/primitives/ClientTabs";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  AgentDotMatrix,
  DOT_MATRIX_PALETTES,
  DOT_SHAPES,
  EXTRA_FACE_SHAPES,
  FACE_SHAPES,
  type DotMatrixPaletteName,
  type DotShapeName,
} from "~/components/primitives/AgentDotMatrix";
import { AgentLogoMorph, AgentOrb, type AgentOrbProps } from "./AgentOrb";

// Experiments for the trigger.dev AI dashboard-agent identity: a resting logo
// that animates while the agent thinks. Each tab is a separate experiment.

export default function Story() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex max-w-3xl flex-col gap-1">
        <Header1>AI agent</Header1>
        <Paragraph variant="small">
          A resting logo that animates while the agent thinks. Each tab is a separate experiment.
        </Paragraph>
      </div>
      <ClientTabs defaultValue="dot-matrix">
        <ClientTabsList variant="underline">
          <ClientTabsTrigger variant="underline" value="dot-matrix">
            Dot matrix
          </ClientTabsTrigger>
          <ClientTabsTrigger variant="underline" value="logo-morph">
            Logo morph
          </ClientTabsTrigger>
          <ClientTabsTrigger variant="underline" value="orbit-dots">
            Orbit dots
          </ClientTabsTrigger>
          <ClientTabsTrigger variant="underline" value="logo-cloud">
            Logo cloud
          </ClientTabsTrigger>
        </ClientTabsList>
        <ClientTabsContent value="dot-matrix">
          <DotMatrixTab />
        </ClientTabsContent>
        <ClientTabsContent value="logo-morph">
          <LogoMorphTab />
        </ClientTabsContent>
        <ClientTabsContent value="orbit-dots">
          <OrbitDotsTab />
        </ClientTabsContent>
        <ClientTabsContent value="logo-cloud">
          <LogoCloudTab />
        </ClientTabsContent>
      </ClientTabs>
    </div>
  );
}

// --- Dot matrix (5x5) ---------------------------------------------------------

// Dark-ink mono ramp for light surfaces (the built-in mono palette is white-based).
const LIGHT_MONO = {
  stops: ["#0d0e12", "#1a1b1f", "#3b3e45"] as [string, string, string],
  glow: "#1a1b1f",
};

function DotMatrixTab() {
  return (
    <div className="flex flex-col gap-6 py-6">
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        5×5 grid. A bright head walks each shape's route on a fixed beat, 2 cycles per shape,
        handing off at shared dots. Click to toggle.
      </Paragraph>
      <div className="flex flex-wrap items-end gap-8 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {[16, 20, 24, 32, 48].map((s) => (
          <div key={s} className="flex flex-col items-center gap-2">
            <div className="flex h-12 items-center">
              <AgentDotMatrix size={s} />
            </div>
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{s}px rest</div>
          </div>
        ))}
      </div>
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        The <code className="text-text-bright">ask-ai</code> Button variant. Mono logo, click to
        think for 5s.
      </Paragraph>
      <div className="flex flex-wrap items-center gap-6 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {(
          [
            ["ask-ai/small", 16, "small"],
            ["ask-ai/medium", 16, "medium"],
            ["ask-ai/large", 20, "large"],
          ] as [ButtonVariant, number, string][]
        ).map(([variant, matrixSize, label]) => (
          <div key={variant} className="flex flex-col items-center gap-2">
            <AskAiButton variant={variant} matrixSize={matrixSize} />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{label}</div>
          </div>
        ))}
      </div>
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        Small-button icon size comparison (crispness):
      </Paragraph>
      <div className="flex flex-wrap items-center gap-6 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {[14, 15, 16].map((s) => (
          <div key={s} className="flex flex-col items-center gap-2">
            <AskAiButton variant="ask-ai/small" matrixSize={s} />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{s}px icon</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-10 rounded-md border border-grid-bright bg-background-bright px-6 py-6">
        {[20, 32, 48, 72].map((s) => (
          <div key={s} className="flex flex-col items-center gap-2">
            <ToggleableMatrix size={s} />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">
              {s}px · click
            </div>
          </div>
        ))}
      </div>
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        Mono on dark (charcoal-800) and light (charcoal-100):
      </Paragraph>
      <div className="flex flex-wrap gap-4">
        <div className="flex items-center gap-8 rounded-md border border-grid-bright bg-charcoal-800 px-6 py-5">
          <AgentDotMatrix size={40} mode="dark" palette="mono" restColor="#d7d9dd" />
          <ToggleableMatrix
            size={40}
            matrix={{ mode: "dark", palette: "mono", restColor: "#d7d9dd" }}
          />
        </div>
        <div className="flex items-center gap-8 rounded-md border border-grid-bright bg-charcoal-100 px-6 py-5">
          <AgentDotMatrix size={40} mode="light" palette={LIGHT_MONO} restColor="#1a1b1f" />
          <ToggleableMatrix
            size={40}
            matrix={{ mode: "light", palette: LIGHT_MONO, restColor: "#1a1b1f" }}
          />
        </div>
      </div>
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        Face suite (small buttons, click to think):
      </Paragraph>
      <div className="flex max-w-4xl flex-wrap gap-3 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {EXTRA_FACE_SHAPES.map((name) => (
          <FaceButton key={name} name={name} />
        ))}
      </div>
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        Face options (grid always visible here):
      </Paragraph>
      <div className="flex flex-wrap items-end gap-8 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {FACE_SHAPES.map((name) => (
          <div key={name} className="flex flex-col items-center gap-2">
            <ToggleableMatrix size={40} matrix={{ restShape: name, gridAtRest: true }} />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{name}</div>
          </div>
        ))}
      </div>
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        Palettes (always running):
      </Paragraph>
      <div className="flex flex-wrap items-end gap-8 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {(Object.keys(DOT_MATRIX_PALETTES) as DotMatrixPaletteName[]).map((name) => (
          <div key={name} className="flex flex-col items-center gap-2">
            <AgentDotMatrix size={48} active palette={name} restColor="palette" />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{name}</div>
          </div>
        ))}
      </div>
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        Shape library (5-line string bitmaps):
      </Paragraph>
      <div className="flex flex-wrap items-end gap-8 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {(Object.keys(DOT_SHAPES) as DotShapeName[]).map((name) => (
          <div key={name} className="flex flex-col items-center gap-2">
            <AgentDotMatrix size={32} restShape={name} />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AskAiButton({ variant, matrixSize }: { variant: ButtonVariant; matrixSize: number }) {
  const [active, setActive] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timeout.current), []);

  const trigger = () => {
    setActive(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setActive(false), 5000);
  };

  // Overrides the variant's built-in static logo so it can animate.
  return (
    <Button
      variant={variant}
      onClick={trigger}
      LeadingIcon={
        <AgentDotMatrix
          size={matrixSize}
          active={active}
          palette="mono"
          restColor="#ffffff"
          decorative
        />
      }
    >
      Ask AI
    </Button>
  );
}

function FaceButton({ name }: { name: DotShapeName }) {
  const [active, setActive] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timeout.current), []);

  const trigger = () => {
    setActive(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setActive(false), 5000);
  };

  return (
    <Button
      variant="ask-ai/small"
      onClick={trigger}
      LeadingIcon={
        <AgentDotMatrix
          size={16}
          active={active}
          restShape={name}
          palette="mono"
          restColor="#ffffff"
          decorative
        />
      }
    >
      {name}
    </Button>
  );
}

function ToggleableMatrix({
  size,
  matrix,
}: {
  size: number;
  matrix?: Partial<React.ComponentProps<typeof AgentDotMatrix>>;
}) {
  const [active, setActive] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setActive((a) => !a)}
      aria-label={active ? "Stop the thinking animation" : "Start the thinking animation"}
      aria-pressed={active}
      title="Click to toggle thinking"
      className="focus-custom cursor-pointer rounded-md p-2 transition hover:bg-background-hover"
    >
      <AgentDotMatrix size={size} active={active} {...matrix} />
    </button>
  );
}

// --- Logo morph (crisp logo -> orbits) -----------------------------------------

function LogoMorphTab() {
  return (
    <div className="flex flex-col gap-6 py-6">
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        Crisp logo at rest; dots born on its outline fly out to orbits. Click or scrub.
      </Paragraph>
      <div className="flex flex-wrap items-end gap-8 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {[16, 20, 24, 32, 48].map((s) => (
          <div key={s} className="flex flex-col items-center gap-2">
            <div className="flex h-12 items-center">
              <AgentLogoMorph size={s} />
            </div>
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{s}px rest</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-10 rounded-md border border-grid-bright bg-background-bright px-6 py-6">
        {[20, 32, 48, 72].map((s) => (
          <div key={s} className="flex flex-col items-center gap-2">
            <TriggerableLogoMorph size={s} />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">
              {s}px · click
            </div>
          </div>
        ))}
      </div>
      <LogoMorphScrubber size={140} />
    </div>
  );
}

function TriggerableLogoMorph({ size }: { size: number }) {
  const [active, setActive] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timeout.current), []);

  const trigger = () => {
    setActive(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setActive(false), 4000);
  };

  return (
    <button
      type="button"
      onClick={trigger}
      aria-label="Trigger the agent thinking animation"
      title="Click to think"
      className="focus-custom cursor-pointer rounded-md p-2 transition hover:bg-background-hover"
    >
      <AgentLogoMorph size={size} active={active} />
    </button>
  );
}

function LogoMorphScrubber({ size = 140 }: { size?: number }) {
  const [value, setValue] = useState(0);

  return (
    <div className="flex flex-col items-start gap-4 rounded-md border border-grid-bright bg-background-bright px-6 py-6">
      <AgentLogoMorph size={size} activation={value} />
      <div className="flex w-full max-w-md items-center gap-3">
        <span className="w-10 text-xs tabular-nums text-text-dimmed">{value.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          onChange={(e) => setValue(parseFloat(e.target.value))}
          aria-label="Morph amount"
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-grid-bright accent-blue-500"
        />
      </div>
      <div className="flex w-full max-w-md justify-between text-[10px] uppercase tracking-wide text-text-dimmed">
        <span>Logo</span>
        <span>Working</span>
      </div>
    </div>
  );
}

// --- Orbit dots (triangle -> tilted 3D orbits) ----------------------------------

function OrbitDotsTab() {
  return (
    <div className="flex flex-col gap-6 py-6">
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        Dotted triangle ↔ tilted 3D orbits. White at rest, palette while working.
      </Paragraph>
      <section className="flex flex-col gap-3">
        <Header2>Static logo</Header2>
        <div className="flex flex-wrap items-end gap-8 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
          {[16, 20, 24, 32, 48].map((s) => (
            <div key={s} className="flex flex-col items-center gap-2">
              <div className="flex h-12 items-center">
                <AgentOrb size={s} adaptive />
              </div>
              <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{s}px</div>
            </div>
          ))}
          <div className="flex items-center gap-3 self-center">
            <div className="flex items-center gap-2 rounded-md bg-tertiary px-3 py-2 text-sm text-text-bright">
              <AgentOrb size={20} adaptive />
              Ask the agent
            </div>
            <div className="flex items-center gap-2 rounded-md bg-tertiary px-3 py-2 text-sm text-text-bright">
              <TriggerTriangle className="h-4 w-auto text-green-500" />
              Ask the agent
            </div>
          </div>
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <Header2>Click to think</Header2>
        <div className="flex flex-wrap items-end gap-10 rounded-md border border-grid-bright bg-background-bright px-6 py-6">
          {[20, 32, 48, 72].map((s) => (
            <div key={s} className="flex flex-col items-center gap-2">
              <TriggerableOrb size={s} orb={{ adaptive: true }} />
              <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{s}px</div>
            </div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <Header2>Variant — white particles</Header2>
        <div className="flex flex-wrap items-end gap-10 rounded-md border border-grid-bright bg-background-bright px-6 py-6">
          {[20, 32, 48, 72].map((s) => (
            <div key={s} className="flex flex-col items-center gap-2">
              <TriggerableOrb size={s} orb={{ colored: false, adaptive: true }} />
              <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{s}px</div>
            </div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <Header2>Morph scrubber</Header2>
        <Scrubber sizes={[20, 32, 48, 72, 140]} orb={{ adaptive: true }} />
      </section>
    </div>
  );
}

// --- Logo cloud (600-dot logo silhouette) ---------------------------------------

const LOGO_CLOUD: Partial<AgentOrbProps> = {
  restShape: "logo",
  dotCount: 600,
  orbitCount: 12,
  particlesPerOrbit: 4,
};

function LogoCloudTab() {
  return (
    <div className="flex flex-col gap-6 py-6">
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        600 dots in the logo silhouette; morphs into a working cloud.
      </Paragraph>
      <div className="flex flex-wrap items-end gap-8 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {[16, 20, 24, 32, 48, 96].map((s) => (
          <div key={s} className="flex flex-col items-center gap-2">
            <div className="flex h-24 items-center">
              <AgentOrb size={s} {...LOGO_CLOUD} />
            </div>
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{s}px</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-10 rounded-md border border-grid-bright bg-background-bright px-6 py-6">
        {[24, 48, 96].map((s) => (
          <div key={s} className="flex flex-col items-center gap-2">
            <TriggerableOrb size={s} orb={LOGO_CLOUD} />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">
              {s}px · click
            </div>
          </div>
        ))}
      </div>
      <Scrubber size={140} orb={LOGO_CLOUD} />
    </div>
  );
}

// --- shared helpers -------------------------------------------------------------

function TriggerableOrb({ size, orb }: { size: number; orb?: Partial<AgentOrbProps> }) {
  const [active, setActive] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timeout.current), []);

  const trigger = () => {
    setActive(true);
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setActive(false), 4000);
  };

  return (
    <button
      type="button"
      onClick={trigger}
      aria-label="Trigger the agent thinking animation"
      title="Click to think"
      className="focus-custom cursor-pointer rounded-md p-2 transition hover:bg-background-hover"
    >
      <AgentOrb size={size} active={active} {...orb} />
    </button>
  );
}

function Scrubber({
  size = 140,
  sizes,
  orb,
}: {
  size?: number;
  sizes?: number[];
  orb?: Partial<AgentOrbProps>;
}) {
  const [value, setValue] = useState(0);
  const sizeList = sizes ?? [size];

  return (
    <div className="flex flex-col items-start gap-4 rounded-md border border-grid-bright bg-background-bright px-6 py-6">
      <div className="flex flex-wrap items-end gap-8">
        {sizeList.map((s) => (
          <div key={s} className="flex flex-col items-center gap-2">
            <AgentOrb size={s} activation={value} {...orb} />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{s}px</div>
          </div>
        ))}
      </div>
      <div className="flex w-full max-w-md items-center gap-3">
        <span className="w-10 text-xs tabular-nums text-text-dimmed">{value.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value}
          onChange={(e) => setValue(parseFloat(e.target.value))}
          aria-label="Morph amount"
          className="h-1 w-full cursor-pointer appearance-none rounded-full bg-grid-bright accent-blue-500"
        />
      </div>
      <div className="flex w-full max-w-md justify-between text-[10px] uppercase tracking-wide text-text-dimmed">
        <span>Triangle</span>
        <span>Working</span>
      </div>
    </div>
  );
}

// The trigger.dev brand triangle, but with a solid `currentColor` fill instead of
// LogoIcon's green→yellow gradient (so it can be coloured via a text-* class).
function TriggerTriangle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 321 282"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M96.1017 113.4L160.679 4.57764e-05L320.718 281.045H0.638916L65.2159 167.642L110.896 194.382L92.0035 227.561H229.354L160.679 106.965L141.786 140.144L96.1017 113.4Z"
        fill="currentColor"
      />
    </svg>
  );
}
