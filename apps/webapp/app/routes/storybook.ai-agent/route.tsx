import { ComponentNames } from "../storybook/StoryKit";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { AlertDotIcon } from "~/assets/icons/AlertDotIcon";
import { CrosshairDotIcon } from "~/assets/icons/CrosshairDotIcon";
import { FingerprintDotIcon } from "~/assets/icons/FingerprintDotIcon";
import { FlashlightDotIcon } from "~/assets/icons/FlashlightDotIcon";
import { InvestigateDotIcon } from "~/assets/icons/InvestigateDotIcon";
import { InvestigateGlassesDotIcon } from "~/assets/icons/InvestigateGlassesDotIcon";
import { RadarDotIcon } from "~/assets/icons/RadarDotIcon";
import { SonarDotIcon } from "~/assets/icons/SonarDotIcon";
import { WatchDotIcon } from "~/assets/icons/WatchDotIcon";
import { LogoIcon } from "~/components/LogoIcon";
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
  AgentMonoLogo,
  DOT_MATRIX_PALETTES,
  DOT_SHAPES,
  EXTRA_FACE_SHAPES,
  FACE_SHAPES,
  type DotMatrixPaletteName,
  type DotShapeName,
} from "~/components/primitives/AgentDotMatrix";

// Experiments for the trigger.dev AI dashboard-agent identity: a resting logo
// that animates while the agent thinks. Each tab is a separate experiment.

export default function Story() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="px-4 pt-4">
        <ComponentNames
          names={[
            "AgentDotMatrix.tsx",
            "InvestigateDotIcon.tsx",
            "InvestigateGlassesDotIcon.tsx",
            "RadarDotIcon.tsx",
            "FingerprintDotIcon.tsx",
            "CrosshairDotIcon.tsx",
            "FlashlightDotIcon.tsx",
            "SonarDotIcon.tsx",
            "WatchDotIcon.tsx",
            "AlertDotIcon.tsx",
          ]}
        />
      </div>
      <div className="flex max-w-3xl flex-col gap-1">
        <Header1>Trigger Agent — Icons & Buttons</Header1>
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
      </ClientTabs>
    </div>
  );
}

// --- Dot matrix (5x5) ---------------------------------------------------------

/** Any `*DotIcon` component: the shared shape shared by every icon in the candidate lists below. */
type DotIconComponent = React.ComponentType<{
  className?: string;
  style?: CSSProperties;
  showGrid?: boolean;
}>;

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
        The <code className="text-text-bright">ask-trigger</code> Button variant. Mono logo, click
        to think for 5s.
      </Paragraph>
      <div className="flex flex-wrap items-center gap-6 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {(
          [
            ["ask-trigger/small", 16, "small"],
            ["ask-trigger/medium", 16, "medium"],
            ["ask-trigger/large", 20, "large"],
          ] as [ButtonVariant, number, string][]
        ).map(([variant, matrixSize, label]) => (
          <div key={variant} className="flex flex-col items-center gap-2">
            <AskTriggerButton variant={variant} matrixSize={matrixSize} />
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
            <AskTriggerButton variant="ask-trigger/small" matrixSize={s} />
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
          <AgentDotMatrix size={40} mode="light" palette="monoLight" restColor="#1a1b1f" />
          <ToggleableMatrix
            size={40}
            matrix={{ mode: "light", palette: "monoLight", restColor: "#1a1b1f" }}
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
      <Paragraph variant="small" className="mt-2 -mb-3 max-w-3xl">
        Action icon candidates — silhouettes on the exact same grid as the shapes above (same
        `dotMatrixGeometry`, grid always visible, same as "Face options"). Every lit dot sits on a
        grid node; none off-grid, none resized. `currentColor`, same box as any other icon. Not
        wired into `InvestigateButton.tsx` / `WatchButton.tsx` — comparison only.
      </Paragraph>
      <div className="flex flex-wrap items-end gap-8 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        {(
          [
            [InvestigateDotIcon, "investigate — magnifier"],
            [InvestigateGlassesDotIcon, "investigate — glasses"],
            [RadarDotIcon, "investigate — radar"],
            [FingerprintDotIcon, "investigate — fingerprint"],
            [CrosshairDotIcon, "investigate — crosshair"],
            [FlashlightDotIcon, "investigate — flashlight"],
            [SonarDotIcon, "investigate — sonar ping"],
          ] as [DotIconComponent, string][]
        ).map(([Icon, label]) => (
          <div key={label} className="flex flex-col items-center gap-2">
            <Icon className="text-text-bright" style={{ width: 32, height: 32 }} showGrid />
            <div className="text-[10px] uppercase tracking-wide text-text-dimmed">{label}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-8 rounded-md border border-grid-bright bg-background-bright px-6 py-5">
        <div className="flex flex-col items-center gap-2">
          <WatchDotIcon className="text-text-bright" style={{ width: 32, height: 32 }} showGrid />
          <div className="text-[10px] uppercase tracking-wide text-text-dimmed">watch — eye</div>
        </div>
        <div className="flex flex-col items-center gap-2">
          <AlertDotIcon className="text-text-bright" style={{ width: 32, height: 32 }} showGrid />
          <div className="text-[10px] uppercase tracking-wide text-text-dimmed">alert — bell</div>
        </div>
      </div>
    </div>
  );
}

function AskTriggerButton({ variant, matrixSize }: { variant: ButtonVariant; matrixSize: number }) {
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
      LeadingIcon={<AgentMonoLogo size={matrixSize} active={active} decorative />}
    >
      Ask Trigger
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
      variant="ask-trigger/small"
      onClick={trigger}
      LeadingIcon={<AgentMonoLogo size={16} active={active} restShape={name} decorative />}
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

// ============================================================================
// Orbit-dots / logo-morph experiment (inlined: contained to this storybook page)
// ============================================================================

// Phase 1 prototype of the trigger.dev "AI dashboard agent" orb.
//
// Rest state = a dotted logo (a triangle outline, or the trigger.dev mark filled
// with a dot cloud). Active state = the "working" animation deconstructed from
// thinking-orbs: dots on tilted 3D orbital rings, each with faint "ghost" dots
// tracing the ring plus a few bright particles orbiting it.
//
// A single eased `activation` (0 = rest, 1 = working) interpolates EVERY dot's
// position, radius, depth, alpha and colour between the two layouts — one shared
// pool of dots morphing, not a cross-fade. Colour ramps linearly white -> palette.

// --- tunables -------------------------------------------------------------

const TRIANGLE_SPREAD = 1.45; // scales the triangle to fill the box
const SHELL = 0.82; // orbit shell radius as a fraction of size/2
const TILT = 0.3; // fixed X-axis tilt of the orbit system (radians)
const SPIN_RATE = 0.12; // how fast the whole system rotates about Y, per time unit

// Tailwind-500 palette (blue, rose, green, amber).
const AGENT_ORB_PALETTE = ["#3b82f6", "#f43f5e", "#22c55e", "#f59e0b"];

// The trigger.dev logo path (from LogoIcon), used to shape the dense dot cloud.
const LOGO_PATH =
  "M96.1017 113.4L160.679 4.57764e-05L320.718 281.045H0.638916L65.2159 167.642L110.896 194.382L92.0035 227.561H229.354L160.679 106.965L141.786 140.144L96.1017 113.4Z";
const LOGO_W = 321;
const LOGO_H = 282;

// --- pure geometry --------------------------------------------------------

type Vec3 = [number, number, number];
type Pt = [number, number];

// Deterministic hash (same as the library's) so orbit orientations are stable.
function hash(i: number, seed: number): number {
  const s = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

type OrbitGeom = {
  basisA: Vec3; // two orthonormal in-plane vectors spanning the ring
  basisB: Vec3;
  radiusFactor: number; // ring radius as a fraction of the shell
  speed: number; // particle angular speed + direction
  phase: number; // shared angular offset for this ring's particles
};

function buildOrbitGeoms(orbitCount: number): OrbitGeom[] {
  return Array.from({ length: orbitCount }, (_, b) => {
    const x = hash(b, 1.7);
    const i = hash(b, 5.2);
    const p = hash(b, 8.9);
    const azimuth = x * 2 * Math.PI;
    const polar = Math.acos(2 * i - 1);
    const nx = Math.sin(polar) * Math.cos(azimuth);
    const ny = Math.cos(polar);
    const nz = Math.sin(polar) * Math.sin(azimuth);
    let ax = -ny;
    let ay = nx;
    const len = Math.max(1e-6, Math.hypot(ax, ay));
    ax /= len;
    ay /= len;
    const basisA: Vec3 = [ax, ay, 0];
    const basisB: Vec3 = [-nz * ay, nz * ax, nx * ay - ny * ax]; // normal × basisA
    return {
      basisA,
      basisB,
      radiusFactor: 0.45 + 0.52 * x,
      speed: (0.25 + 0.55 * p) * (p > 0.5 ? 1 : -1),
      phase: i * 6,
    };
  });
}

type DotSpec = {
  orbit: number;
  ghost: boolean;
  ringAngle: number;
};

// Assign each dot to an orbit (round-robin so rings stay balanced at any count);
// the first `particlesPerOrbit` dots of each ring are bright particles, the rest
// are faint ghosts. Angles are spread evenly around each ring.
function buildDotSpecs(dotCount: number, orbitCount: number, particlesPerOrbit: number): DotSpec[] {
  const members: number[][] = Array.from({ length: orbitCount }, () => []);
  for (let i = 0; i < dotCount; i++) {
    members[i % orbitCount].push(i);
  }
  const specs: DotSpec[] = new Array(dotCount);
  for (let b = 0; b < orbitCount; b++) {
    const ring = members[b];
    for (let k = 0; k < ring.length; k++) {
      specs[ring[k]] = {
        orbit: b,
        ghost: k >= particlesPerOrbit,
        ringAngle: (k / Math.max(1, ring.length)) * 2 * Math.PI,
      };
    }
  }
  return specs;
}

// Arc-length parameterizer for a closed polygon: f in [0,1] -> point spaced by
// perimeter distance so dots are evenly distributed.
function makePolygonSampler(points: Pt[]): (f: number) => Pt {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(d);
    total += d;
  }
  return (f) => {
    let dist = f * total;
    let i = 0;
    while (dist > seg[i] && i < seg.length - 1) {
      dist -= seg[i];
      i++;
    }
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const t = seg[i] ? Math.min(1, dist / seg[i]) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
}

const triangleAt = makePolygonSampler([
  [0, -0.26],
  [0.24, 0.16],
  [-0.24, 0.16],
]);

// Rest positions in "fraction of size" units (render maps center + pt * size).
function triangleOutline(count: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const [tx, ty] = triangleAt(i / count);
    pts.push([tx * TRIANGLE_SPREAD, ty * TRIANGLE_SPREAD]);
  }
  return pts;
}

// Project a 3D ring point to screen space (+ depth). Same math as the library's `q`.
function project(x: number, y: number, z: number, spin: number, center: number): Vec3 {
  const st = Math.sin(TILT);
  const ct = Math.cos(TILT);
  const ss = Math.sin(spin);
  const cs = Math.cos(spin);
  const u = x * cs + z * ss;
  const h = -x * ss + z * cs;
  const b = y * ct - h * st;
  const depth = y * st + h * ct;
  return [center + u, center - b, depth];
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// Size-adaptive dots: small orbs get fewer, chunkier dots so they stay legible;
// larger orbs keep the denser, finer look. (48px+ matches the non-adaptive 12.)
function adaptiveDots(size: number): {
  dotCount: number;
  particlesPerOrbit: number;
  radiusScale: number;
} {
  if (size <= 24) return { dotCount: 6, particlesPerOrbit: 2, radiusScale: 1.7 };
  if (size <= 40) return { dotCount: 9, particlesPerOrbit: 3, radiusScale: 1.25 };
  return { dotCount: 12, particlesPerOrbit: 3, radiusScale: 1 };
}

// --- the per-frame painter ------------------------------------------------

type RenderConfig = {
  size: number;
  restPoints: Pt[];
  dotSpecs: DotSpec[];
  orbitGeoms: OrbitGeom[];
  paletteRgb: [number, number, number][];
  restRgb: [number, number, number];
  colored: boolean;
  radiusScale: number;
};

function drawFrame(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  activation: number,
  time: number,
  cfg: RenderConfig
) {
  const { size, restPoints, dotSpecs, orbitGeoms, paletteRgb, restRgb, colored, radiusScale } = cfg;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const center = size / 2;
  const shell = (size / 2) * SHELL;
  const spin = time * SPIN_RATE;
  const triRadius = Math.max(0.55, size * 0.03) * radiusScale;

  const dots: { x: number; y: number; r: number; z: number; fill: string }[] = [];

  for (let i = 0; i < dotSpecs.length; i++) {
    const home = restPoints[i];
    if (!home) continue;
    const spec = dotSpecs[i];
    const geom = orbitGeoms[spec.orbit];

    const homeX = center + home[0] * size;
    const homeY = center + home[1] * size;

    // Live orbit point (3D -> screen).
    const ringR = shell * geom.radiusFactor;
    const angle = spec.ghost ? spec.ringAngle : time * geom.speed + spec.ringAngle + geom.phase;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const px = (geom.basisA[0] * ca + geom.basisB[0] * sa) * ringR;
    const py = (geom.basisA[1] * ca + geom.basisB[1] * sa) * ringR;
    const pz = (geom.basisA[2] * ca + geom.basisB[2] * sa) * ringR;
    const [sx, sy, depth] = project(px, py, pz, spin, center);
    const front = Math.min(1, Math.max(0, (depth / ringR + 1) / 2)); // 0 back .. 1 front

    const orbitRadius = spec.ghost
      ? Math.max(0.4, size * 0.022) * radiusScale
      : Math.max(0.5, size * (0.026 + 0.03 * front)) * radiusScale;
    const orbitAlpha = spec.ghost ? 0.5 * (0.35 + 0.65 * front) : 0.6 + 0.4 * front;

    // Interpolate rest -> orbit by activation.
    const x = mix(homeX, sx, activation);
    const y = mix(homeY, sy, activation);
    const r = mix(triRadius, orbitRadius, activation);
    const alpha = mix(1, orbitAlpha, activation);

    let cr = restRgb[0];
    let cg = restRgb[1];
    let cb = restRgb[2];
    if (colored) {
      const target = paletteRgb[i % paletteRgb.length];
      cr = Math.round(mix(restRgb[0], target[0], activation));
      cg = Math.round(mix(restRgb[1], target[1], activation));
      cb = Math.round(mix(restRgb[2], target[2], activation));
    }

    dots.push({ x, y, r, z: depth * activation, fill: `rgba(${cr},${cg},${cb},${alpha})` });
  }

  dots.sort((a, b) => a.z - b.z); // far dots first (no-op at rest since z = depth * 0)
  for (const d of dots) {
    ctx.fillStyle = d.fill;
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(0.3, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
}

// --- component ------------------------------------------------------------

type AgentOrbProps = {
  /** Rendered size in CSS pixels. Tuned to look right down to ~20px. */
  size?: number;
  /** Drives the morph: false = static rest shape, true = working animation. */
  active?: boolean;
  /** Controlled override of the morph amount (0..1); ignores `active` when set. */
  activation?: number;
  /** Per-dot colours shown while working (cycled by index). */
  colors?: string[];
  /** Ink colour at rest, and for every dot when `colored` is false. */
  restColor?: string;
  /** When false, dots stay `restColor` (white) — only alpha/size/position animate. */
  colored?: boolean;
  /** Rest layout: a triangle outline, or a dense fill of the trigger.dev logo. */
  restShape?: "triangle";
  /** Total dots in the shared pool. More dots + `logo` shape = solid-logo look. */
  dotCount?: number;
  /** Number of orbital rings in the working state. */
  orbitCount?: number;
  /** Bright orbiting particles per ring (the rest are faint ghosts). */
  particlesPerOrbit?: number;
  /** Auto-tune dot count + dot size to `size` (fewer, chunkier dots when small). */
  adaptive?: boolean;
  /** Orbit speed multiplier (3.9 matches the library's 20px "working"). */
  speed?: number;
  /** Morph duration when `active` toggles, in ms. */
  transitionMs?: number;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

function AgentOrb({
  size = 20,
  active = false,
  activation,
  colors = AGENT_ORB_PALETTE,
  restColor = "#ffffff",
  colored = true,
  dotCount = 21,
  orbitCount = 3,
  particlesPerOrbit = 3,
  adaptive = false,
  speed = 3.9,
  transitionMs = 600,
  className,
  style,
  "aria-label": ariaLabel,
}: AgentOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeRef = useRef(active);
  const controlledRef = useRef(activation);
  const amountRef = useRef(activation ?? (active ? 1 : 0));
  const timeRef = useRef(0);
  const wakeRef = useRef<() => void>(() => {});

  const colorsKey = colors.join(",");
  const adaptiveParams = adaptive ? adaptiveDots(size) : null;
  const effDotCount = adaptiveParams?.dotCount ?? dotCount;
  const effParticles = adaptiveParams?.particlesPerOrbit ?? particlesPerOrbit;
  const radiusScale = adaptiveParams?.radiusScale ?? 1;
  const orbitGeoms = useMemo(() => buildOrbitGeoms(orbitCount), [orbitCount]);
  const dotSpecs = useMemo(
    () => buildDotSpecs(effDotCount, orbitCount, effParticles),
    [effDotCount, orbitCount, effParticles]
  );
  const restPoints = useMemo(() => triangleOutline(effDotCount), [effDotCount]);

  useEffect(() => {
    activeRef.current = active;
    controlledRef.current = activation;
    wakeRef.current();
  }, [active, activation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(2, typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const cfg: RenderConfig = {
      size,
      restPoints,
      dotSpecs,
      orbitGeoms,
      paletteRgb: colorsKey.split(",").map(hexToRgb),
      restRgb: hexToRgb(restColor),
      colored,
      radiusScale,
    };

    const reduced =
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      // No animation, but a controlled amount (the scrubber) is a static pose,
      // so still honour it and repaint when it changes.
      const paint = () => {
        const amount = controlledRef.current ?? (activeRef.current ? 1 : 0);
        amountRef.current = amount;
        drawFrame(ctx, dpr, amount, 0, cfg);
      };
      wakeRef.current = paint;
      paint();
      return () => {
        wakeRef.current = () => {};
      };
    }

    let raf = 0;
    let running = false;
    let last = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const controlled = controlledRef.current;
      let keepGoing: boolean;

      if (controlled != null) {
        amountRef.current = controlled;
        keepGoing = controlled > 0;
      } else {
        const target = activeRef.current ? 1 : 0;
        const step = transitionMs > 0 ? (dt * 1000) / transitionMs : 1;
        if (amountRef.current < target) {
          amountRef.current = Math.min(target, amountRef.current + step);
        } else if (amountRef.current > target) {
          amountRef.current = Math.max(target, amountRef.current - step);
        }
        keepGoing = amountRef.current !== target || target === 1;
      }

      if (amountRef.current > 0) {
        timeRef.current += dt * speed;
      }
      drawFrame(ctx, dpr, amountRef.current, timeRef.current, cfg);

      if (keepGoing) {
        raf = requestAnimationFrame(frame);
      } else {
        running = false;
      }
    };

    const wake = () => {
      if (running) return;
      running = true;
      last = typeof performance !== "undefined" ? performance.now() : 0;
      raf = requestAnimationFrame(frame);
    };
    wakeRef.current = wake;

    drawFrame(ctx, dpr, amountRef.current, timeRef.current, cfg);
    wake();

    return () => {
      running = false;
      wakeRef.current = () => {};
      cancelAnimationFrame(raf);
    };
  }, [
    size,
    speed,
    transitionMs,
    colorsKey,
    restColor,
    colored,
    radiusScale,
    orbitGeoms,
    dotSpecs,
    restPoints,
  ]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={ariaLabel ?? (active ? "Agent thinking" : "Agent")}
      className={className}
      style={{ width: size, height: size, display: "block", ...style }}
    />
  );
}

// --- crisp logo -> orbits variant -----------------------------------------
//
// Rest = the real crisp LogoIcon (a separate SVG layer). The 21 dots are
// anchored to the logo's actual outline and born in its green, so as the solid
// mark fades they materialise on its edge, then fly out to the orbits and bloom
// into the palette. Two timing windows make the handoff seamless:
//   0.00 - 0.30  logo fades out; dots fade in, held still on the outline (green)
//   0.30 - 1.00  dots fly outline -> orbit, bloom green -> palette, gain depth

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// 21 points evenly along the logo outline via the real vector path, normalized
// to the same box the crisp LogoIcon fills (width-limited, letterboxed). Cached
// per count; client-only (needs an SVG in the DOM to measure).
const LOGO_OUTLINE_CACHE = new Map<number, Pt[]>();
function logoOutlinePoints(count: number): Pt[] {
  if (typeof document === "undefined") return [];
  const cached = LOGO_OUTLINE_CACHE.get(count);
  if (cached) return cached;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("style", "position:absolute;left:-9999px;width:0;height:0;overflow:hidden");
  const path = document.createElementNS(ns, "path") as SVGPathElement;
  path.setAttribute("d", LOGO_PATH);
  svg.appendChild(path);
  document.body.appendChild(svg);

  const total = path.getTotalLength();
  const yOffset = (1 - LOGO_H / LOGO_W) / 2; // LogoIcon is width-limited, so letterboxed vertically
  const pts: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const p = path.getPointAtLength((i / count) * total);
    pts.push([p.x / LOGO_W, p.y / LOGO_W + yOffset]);
  }
  document.body.removeChild(svg);
  LOGO_OUTLINE_CACHE.set(count, pts);
  return pts;
}

type LogoMorphConfig = {
  size: number;
  outline: Pt[];
  dotSpecs: DotSpec[];
  orbitGeoms: OrbitGeom[];
  paletteRgb: [number, number, number][];
  logoRgb: [number, number, number];
};

function drawLogoMorphFrame(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  activation: number,
  time: number,
  cfg: LogoMorphConfig
) {
  const { size, outline, dotSpecs, orbitGeoms, paletteRgb, logoRgb } = cfg;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const dotOpacity = smoothstep(0.05, 0.3, activation);
  if (dotOpacity <= 0.001) return; // rest: only the crisp logo shows

  const fly = smoothstep(0.3, 1, activation); // outline -> orbit
  const colorAmount = smoothstep(0.35, 1, activation); // green -> palette
  const center = size / 2;
  const shell = (size / 2) * SHELL;
  const spin = time * SPIN_RATE;
  const restRadius = Math.max(0.55, size * 0.03);

  const dots: { x: number; y: number; r: number; z: number; fill: string }[] = [];
  for (let i = 0; i < dotSpecs.length; i++) {
    const home = outline[i];
    if (!home) continue;
    const spec = dotSpecs[i];
    const geom = orbitGeoms[spec.orbit];

    const homeX = home[0] * size; // absolute fraction, aligned to the crisp logo
    const homeY = home[1] * size;

    const ringR = shell * geom.radiusFactor;
    const angle = spec.ghost ? spec.ringAngle : time * geom.speed + spec.ringAngle + geom.phase;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const px = (geom.basisA[0] * ca + geom.basisB[0] * sa) * ringR;
    const py = (geom.basisA[1] * ca + geom.basisB[1] * sa) * ringR;
    const pz = (geom.basisA[2] * ca + geom.basisB[2] * sa) * ringR;
    const [sx, sy, depth] = project(px, py, pz, spin, center);
    const front = Math.min(1, Math.max(0, (depth / ringR + 1) / 2));

    const orbitRadius = spec.ghost
      ? Math.max(0.4, size * 0.022)
      : Math.max(0.5, size * (0.026 + 0.03 * front));
    const orbitAlpha = spec.ghost ? 0.5 * (0.35 + 0.65 * front) : 0.6 + 0.4 * front;

    const x = mix(homeX, sx, fly);
    const y = mix(homeY, sy, fly);
    const r = mix(restRadius, orbitRadius, fly);
    const alpha = mix(1, orbitAlpha, fly) * dotOpacity;
    const target = paletteRgb[i % paletteRgb.length];
    const cr = Math.round(mix(logoRgb[0], target[0], colorAmount));
    const cg = Math.round(mix(logoRgb[1], target[1], colorAmount));
    const cb = Math.round(mix(logoRgb[2], target[2], colorAmount));

    dots.push({ x, y, r, z: depth * fly, fill: `rgba(${cr},${cg},${cb},${alpha})` });
  }

  dots.sort((a, b) => a.z - b.z);
  for (const d of dots) {
    ctx.fillStyle = d.fill;
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(0.3, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
}

type AgentLogoMorphProps = {
  size?: number;
  active?: boolean;
  activation?: number;
  colors?: string[];
  /** Colour the dots are born as during the handoff (matches the logo green). */
  logoColor?: string;
  dotCount?: number;
  orbitCount?: number;
  particlesPerOrbit?: number;
  speed?: number;
  transitionMs?: number;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

function AgentLogoMorph({
  size = 20,
  active = false,
  activation,
  colors = AGENT_ORB_PALETTE,
  logoColor = "#41ff54",
  dotCount = 21,
  orbitCount = 3,
  particlesPerOrbit = 3,
  speed = 3.9,
  transitionMs = 600,
  className,
  style,
  "aria-label": ariaLabel,
}: AgentLogoMorphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);

  const activeRef = useRef(active);
  const controlledRef = useRef(activation);
  const amountRef = useRef(activation ?? (active ? 1 : 0));
  const timeRef = useRef(0);
  const wakeRef = useRef<() => void>(() => {});

  const colorsKey = colors.join(",");

  useEffect(() => {
    activeRef.current = active;
    controlledRef.current = activation;
    wakeRef.current();
  }, [active, activation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(2, typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const cfg: LogoMorphConfig = {
      size,
      outline: logoOutlinePoints(dotCount),
      dotSpecs: buildDotSpecs(dotCount, orbitCount, particlesPerOrbit),
      orbitGeoms: buildOrbitGeoms(orbitCount),
      paletteRgb: colorsKey.split(",").map(hexToRgb),
      logoRgb: hexToRgb(logoColor),
    };

    const setLogo = (a: number) => {
      const el = logoRef.current;
      if (!el) return;
      const hand = smoothstep(0, 0.3, a);
      el.style.opacity = String(1 - hand);
      el.style.transform = `scale(${1 - 0.06 * hand})`;
      el.style.visibility = hand >= 0.999 ? "hidden" : "visible";
    };

    const reduced =
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      // Same as the orb: freeze the animation, but still render a controlled
      // amount so the scrubber keeps working.
      const paint = () => {
        const amount = controlledRef.current ?? (activeRef.current ? 1 : 0);
        amountRef.current = amount;
        setLogo(amount);
        drawLogoMorphFrame(ctx, dpr, amount, 0, cfg);
      };
      wakeRef.current = paint;
      paint();
      return () => {
        wakeRef.current = () => {};
      };
    }

    let raf = 0;
    let running = false;
    let last = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      const controlled = controlledRef.current;
      let keepGoing: boolean;
      if (controlled != null) {
        amountRef.current = controlled;
        keepGoing = controlled > 0;
      } else {
        const target = activeRef.current ? 1 : 0;
        const step = transitionMs > 0 ? (dt * 1000) / transitionMs : 1;
        if (amountRef.current < target) {
          amountRef.current = Math.min(target, amountRef.current + step);
        } else if (amountRef.current > target) {
          amountRef.current = Math.max(target, amountRef.current - step);
        }
        keepGoing = amountRef.current !== target || target === 1;
      }

      const a = amountRef.current;
      if (a > 0) {
        timeRef.current += dt * speed;
      }
      setLogo(a);
      drawLogoMorphFrame(ctx, dpr, a, timeRef.current, cfg);

      if (keepGoing) {
        raf = requestAnimationFrame(frame);
      } else {
        running = false;
      }
    };

    const wake = () => {
      if (running) return;
      running = true;
      last = typeof performance !== "undefined" ? performance.now() : 0;
      raf = requestAnimationFrame(frame);
    };
    wakeRef.current = wake;

    setLogo(amountRef.current);
    drawLogoMorphFrame(ctx, dpr, amountRef.current, timeRef.current, cfg);
    wake();

    return () => {
      running = false;
      wakeRef.current = () => {};
      cancelAnimationFrame(raf);
    };
  }, [size, speed, transitionMs, colorsKey, logoColor, dotCount, orbitCount, particlesPerOrbit]);

  return (
    <span
      className={className}
      style={{ position: "relative", display: "inline-block", width: size, height: size, ...style }}
      role="img"
      aria-label={ariaLabel ?? (active ? "Agent thinking" : "Agent")}
    >
      <div
        ref={logoRef}
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "center",
          willChange: "opacity, transform",
        }}
      >
        <LogoIcon className="h-full w-full" />
      </div>
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
    </span>
  );
}
