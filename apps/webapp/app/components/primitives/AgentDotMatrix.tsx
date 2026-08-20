import { type CSSProperties, useEffect, useRef } from "react";
import { useThemeMode } from "~/hooks/useThemeMode";

// Our own 5x5 dot-matrix system, reverse-engineered from dotmatrix
// (github.com/zzzzshawn/matrix) but written from scratch on canvas.
//
// Their architecture, which we keep:
// - Shapes are masks over a fixed 5x5 grid of dots.
// - Animations are a bright "head" walking an ordered route through the
//   shape's dots with a falling-off tail (their "Pulse Ladder" snake), over a
//   dim base level.
// - Colors are 3-stop gradient presets with a separate glow color.
//
// What we change:
// - Shapes are authored as 5-line string bitmaps and the walk route is derived
//   automatically (clockwise by angle from the center).
// - The gradient is evaluated ACROSS the grid at 135deg, so the matrix itself
//   shows the sweep.
// - The full 5x5 grid is always visible: unlit cells are faint grey ghosts.
// - METRONOMIC transitions: the head never leaves the grid and never breaks
//   its step rhythm. When a shape has run its cycles, the head keeps stepping
//   until it lands on a dot SHARED with the next shape, then the next shape's
//   route starts from that overlapped dot (route rotated to it) while the base
//   dots crossfade. Same rule carries the head out of the rest logo and back
//   into it. The default playlist is sequenced so every consecutive pair of
//   shapes shares dots.

const MATRIX = 5;

// --- shapes (5-line bitmaps: "o" = dot on) ---------------------------------

export const DOT_SHAPES = {
  // Rest faces — human, invader, cat, alien, robot, ghost.
  face: [".....", ".o.o.", ".....", "o...o", ".ooo."],
  invader: [".o.o.", "ooooo", "o.o.o", "ooooo", "o...o"],
  cat: ["o...o", "ooooo", "o.o.o", "ooooo", ".ooo."],
  alien: ["o...o", ".ooo.", "ooooo", "o.o.o", ".ooo."],
  robot: ["ooooo", "o.o.o", "ooooo", "o...o", "ooooo"],
  ghost: [".ooo.", "ooooo", "o.o.o", "ooooo", "o.o.o"],
  // Extended face set.
  owl: ["o...o", "ooooo", "o.o.o", ".ooo.", "..o.."],
  dog: ["o...o", "ooooo", "o.o.o", "ooooo", "..o.."],
  bunny: [".o.o.", ".o.o.", "ooooo", "o.o.o", ".ooo."],
  bear: [".o.o.", "ooooo", "o.o.o", "ooooo", ".ooo."],
  fox: ["o...o", "oo.oo", "ooooo", ".ooo.", "..o.."],
  mouse: ["oo.oo", "ooooo", "o.o.o", ".ooo.", "..o.."],
  koala: ["oo.oo", "ooooo", "o.o.o", "ooooo", ".ooo."],
  frog: [".o.o.", ".ooo.", "ooooo", "o.o.o", "ooooo"],
  penguin: [".ooo.", "ooooo", "o.o.o", "ooooo", "o...o"],
  bat: ["o...o", "ooooo", "o.o.o", ".o.o.", "..o.."],
  crab: ["o...o", "o.o.o", "ooooo", "ooooo", ".o.o."],
  spider: ["o.o.o", ".ooo.", "ooooo", ".ooo.", "o.o.o"],
  octopus: [".ooo.", "ooooo", "o.o.o", ".ooo.", "o.o.o"],
  skull: [".ooo.", "ooooo", "o.o.o", ".ooo.", ".o.o."],
  cyclops: [".ooo.", "ooooo", "oo.oo", ".ooo.", "..o.."],
  sprite: [".ooo.", "ooooo", "o.o.o", ".ooo.", "..o.."],
  clown: ["o.o.o", "ooooo", "o.o.o", "ooooo", ".ooo."],
  mech: ["ooooo", "o.o.o", "ooooo", ".o.o.", "ooooo"],
  angel: [".ooo.", ".....", "ooooo", "o.o.o", ".ooo."],
  pumpkin: ["..o..", ".ooo.", "o.o.o", "ooooo", ".ooo."],
  // Cycle shapes.
  square: ["ooooo", "o...o", "o...o", "o...o", "ooooo"],
  rectH: [".....", "ooooo", "o...o", "ooooo", "....."],
  rectV: [".ooo.", ".o.o.", ".o.o.", ".o.o.", ".ooo."],
  circle: [".ooo.", "o...o", "o...o", "o...o", ".ooo."],
  diamond: ["..o..", ".o.o.", "o...o", ".o.o.", "..o.."],
  heart: [".o.o.", "ooooo", "ooooo", ".ooo.", "..o.."],
  checker: ["o.o.o", ".o.o.", "o.o.o", ".o.o.", "o.o.o"],
} satisfies Record<string, string[]>;

export type DotShapeName = keyof typeof DOT_SHAPES;

export const FACE_SHAPES: DotShapeName[] = ["face", "invader", "cat", "alien", "robot", "ghost"];

export const EXTRA_FACE_SHAPES: DotShapeName[] = [
  "owl",
  "dog",
  "bunny",
  "bear",
  "fox",
  "mouse",
  "koala",
  "frog",
  "penguin",
  "bat",
  "crab",
  "spider",
  "octopus",
  "skull",
  "cyclops",
  "sprite",
  "clown",
  "mech",
  "angel",
  "pumpkin",
];

// Sequenced so every consecutive pair (including the wrap) shares dots — the
// head hands off between shapes without ever jumping.
const DEFAULT_PLAYLIST: DotShapeName[] = [
  "square",
  "rectH",
  "circle",
  "diamond",
  "checker",
  "rectV",
  "heart",
];

// --- palettes (3-stop gradient + glow, like their color presets) -----------

export type DotMatrixPalette = {
  /** 3 gradient stops, applied across the grid at 135deg. */
  stops: [string, string, string];
  /** Glow color for bright dots (defaults to the middle stop). */
  glow?: string;
};

export const DOT_MATRIX_PALETTES = {
  mono: { stops: ["#e2e8f0", "#ffffff", "#94a3b8"], glow: "#ffffff" },
  /** `mono` mirrored for light surfaces, where the white ramp would vanish. */
  monoLight: { stops: ["#2b2c2f", "#1a1b1f", "#585c64"], glow: "#1a1b1f" },
  trigger: { stops: ["#41ff54", "#a4ff53", "#e7ff52"], glow: "#86ff53" },
  aurora: { stops: ["#ff3cac", "#784ba0", "#2b86c5"], glow: "#9c64bf" },
  ocean: { stops: ["#00c6ff", "#0072ff", "#4facfe"], glow: "#2f8fff" },
  sunset: { stops: ["#ff5f6d", "#ffc371", "#ffe29a"], glow: "#ff8b73" },
  neon: { stops: ["#b4ff39", "#39ffb6", "#00d4ff"], glow: "#59ffc8" },
} satisfies Record<string, DotMatrixPalette>;

export type DotMatrixPaletteName = keyof typeof DOT_MATRIX_PALETTES;

// --- geometry / precomputation ----------------------------------------------

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  let h = hex.replace("#", "");
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [
  mix(a[0], b[0], t),
  mix(a[1], b[1], t),
  mix(a[2], b[2], t),
];

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

function parseShape(bitmap: string[]): boolean[] {
  const mask = new Array<boolean>(MATRIX * MATRIX).fill(false);
  for (let row = 0; row < MATRIX; row++) {
    for (let col = 0; col < MATRIX; col++) {
      if (bitmap[row]?.[col] === "o") {
        mask[row * MATRIX + col] = true;
      }
    }
  }
  return mask;
}

// Route = the shape's dots ordered clockwise by angle from the center starting
// at the top (ties: outer dots first). This is what the bright head walks.
function buildRoute(mask: boolean[]): number[] {
  const center = (MATRIX - 1) / 2;
  const cells: { index: number; angle: number; radius: number }[] = [];
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const row = Math.floor(index / MATRIX);
    const col = index % MATRIX;
    const dx = col - center;
    const dy = row - center;
    // 0 at 12 o'clock, increasing clockwise.
    const angle = (Math.atan2(dx, -dy) + 2 * Math.PI) % (2 * Math.PI);
    cells.push({ index, angle, radius: Math.hypot(dx, dy) });
  }
  cells.sort((a, b) => a.angle - b.angle || b.radius - a.radius);
  return cells.map((c) => c.index);
}

// Rotate a cyclic route so it starts at `startCell` (falls back unrotated).
function rotateRoute(route: number[], startCell: number): number[] {
  const at = route.indexOf(startCell);
  if (at <= 0) return route;
  return [...route.slice(at), ...route.slice(0, at)];
}

// Sample the 3-stop ramp at a continuous 0..1 position along the 135deg sweep.
function sampleRamp(stops: [Rgb, Rgb, Rgb], t: number): Rgb {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped <= 0.5
    ? mixRgb(stops[0], stops[1], clamped * 2)
    : mixRgb(stops[1], stops[2], (clamped - 0.5) * 2);
}

function paletteColors(stops: [Rgb, Rgb, Rgb]): Rgb[] {
  const colors: Rgb[] = [];
  for (let index = 0; index < MATRIX * MATRIX; index++) {
    const row = Math.floor(index / MATRIX);
    const col = index % MATRIX;
    colors.push(sampleRamp(stops, (col / (MATRIX - 1) + row / (MATRIX - 1)) / 2));
  }
  return colors;
}

// Their Pulse Ladder falloff. Applied over the head's recent HISTORY (not
// route math), so the tail trails naturally through shape handoffs.
const SNAKE_TAIL = [1, 0.82, 0.68, 0.54, 0.42, 0.31, 0.22, 0.14];

// --- component ---------------------------------------------------------------

export type AgentDotMatrixProps = {
  /** Rendered size in CSS pixels. */
  size?: number;
  /** false = static rest shape; true = animate through the playlist. */
  active?: boolean;
  /** The resting shape (the "logo"). */
  restShape?: DotShapeName;
  /** Shapes cycled through while thinking (consecutive shapes should overlap). */
  playlist?: DotShapeName[];
  /** Full route cycles each shape runs before handing off. */
  cyclesPerShape?: number;
  /** 3-stop gradient palette (name or custom) used while thinking. */
  palette?: DotMatrixPaletteName | DotMatrixPalette;
  /** Rest-state dot color; "palette" (default) themes the logo with the gradient. */
  restColor?: string | "palette";
  /** Opacity pair: dim base for shape dots, peak for the head/rest logo. */
  opacityBase?: number;
  opacityPeak?: number;
  /**
   * Which background the matrix sits on. The ghost grid is white ink at low
   * opacity for dark surfaces (reads as subtle grey) and black ink for light.
   */
  mode?: "dark" | "light";
  /** Opacity of the ghost grid (0 disables it). */
  gridOpacity?: number;
  /**
   * When false (default), the ghost grid is transparent while resting (only
   * the logo's dots show) and fades in while thinking. True: always visible.
   */
  gridAtRest?: boolean;
  /** Animation speed multiplier. */
  speed?: number;
  /**
   * Render as a decorative glyph (aria-hidden, no role) — use when the logo
   * sits beside a text label that already names the control.
   */
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
};

const STEP_MS = 60;
const BLEND_MS = 240;

export function AgentDotMatrix({
  size = 20,
  active = false,
  restShape = "alien",
  playlist = DEFAULT_PLAYLIST,
  cyclesPerShape = 2,
  palette = "trigger",
  restColor = "palette",
  opacityBase = 0.3,
  opacityPeak = 0.95,
  mode = "dark",
  gridOpacity = 0.18,
  gridAtRest = false,
  speed = 1,
  decorative = false,
  className,
  style,
  "aria-label": ariaLabel,
}: AgentDotMatrixProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  const wakeRef = useRef<() => void>(() => {});

  const paletteObj: DotMatrixPalette =
    typeof palette === "string" ? DOT_MATRIX_PALETTES[palette] : palette;
  const paletteKey = paletteObj.stops.join(",") + (paletteObj.glow ?? "");
  const playlistKey = playlist.join(",");
  const paletteObjRef = useRef(paletteObj);
  const playlistRef = useRef(playlist);
  paletteObjRef.current = paletteObj;
  playlistRef.current = playlist;

  useEffect(() => {
    activeRef.current = active;
    wakeRef.current();
  }, [active]);

  useEffect(() => {
    // The serialized keys restart this animation when contents change; refs avoid restarting for
    // equivalent array/object identities while still exposing the matching current values.
    const paletteObj = paletteObjRef.current;
    const playlist = playlistRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(2, typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);

    const shapeNames: DotShapeName[] = [restShape, ...playlist];
    const masks = new Map<DotShapeName, boolean[]>();
    const routes = new Map<DotShapeName, number[]>();
    for (const name of shapeNames) {
      const mask = parseShape(DOT_SHAPES[name]);
      masks.set(name, mask);
      routes.set(name, buildRoute(mask));
    }
    const stops = paletteObj.stops.map(hexToRgb) as [Rgb, Rgb, Rgb];
    const gridColors = paletteColors(stops);
    const glowRgb = hexToRgb(paletteObj.glow ?? paletteObj.stops[1]);
    const restRgb: Rgb[] =
      restColor === "palette" ? gridColors : new Array(MATRIX * MATRIX).fill(hexToRgb(restColor));
    const restMask = masks.get(restShape)!;

    const pitch = size / MATRIX;
    const dotR = Math.max(0.75, pitch * 0.3);
    // Clamp: a zero or negative speed would make stepMs non-positive and spin
    // the step loop forever.
    const safeSpeed = Math.max(0.01, speed);
    const stepMs = STEP_MS / safeSpeed;
    const blendMs = BLEND_MS / safeSpeed;
    // White ink at low opacity reads as subtle grey on any dark background;
    // light mode flips to black ink.
    const gridRgb: Rgb = mode === "light" ? [0, 0, 0] : [255, 255, 255];

    // --- engine state (refs only; no React re-renders) ---
    // The head is metronomic: while running it moves exactly one route dot per
    // step, including straight through shape handoffs (shared dot = no jump).
    let running_shape = false; // false = at rest (no head)
    let route: number[] = []; // current (rotated) route
    let playlistIdx = -1;
    let headPos = 0; // index into route
    let stepsInShape = 0;
    let stepClock = 0;
    let seeking: "next" | "rest" | null = null;
    let seekSteps = 0;
    const history: number[] = []; // recent head cells, newest first
    let tailFade = 1; // ramps to 0 while settling back to rest
    let gridFade = gridAtRest ? 1 : 0; // ghost-grid visibility (fades with activity)
    let glowFade = 0; // dot glow only while animating — static logos have no glow
    // Base crossfade between the previous and current shape's dim base maps.
    let blendT = 1;
    const baseFrom = new Float64Array(MATRIX * MATRIX);
    const blendFrom = new Float64Array(MATRIX * MATRIX);
    const baseTo = new Float64Array(MATRIX * MATRIX);
    const blendTo = new Float64Array(MATRIX * MATRIX);

    const setTargetMaps = (m: boolean[], level: number, colorBlend: number) => {
      for (let i = 0; i < baseTo.length; i++) {
        baseTo[i] = m[i] ? level : 0;
        blendTo[i] = m[i] ? colorBlend : 0;
      }
    };

    const snapshotToFrom = () => {
      const t = smoothstep(blendT);
      for (let i = 0; i < baseFrom.length; i++) {
        baseFrom[i] = mix(baseFrom[i], baseTo[i], t);
        blendFrom[i] = mix(blendFrom[i], blendTo[i], t);
      }
      blendT = 0;
    };

    // Initial pose: rest logo, fully blended.
    setTargetMaps(restMask, opacityPeak, 0);
    baseFrom.set(baseTo);
    blendFrom.set(blendTo);

    // Shared-dot handoff: rotate the target's route to start at the head's
    // current cell (guaranteed shared by the playlist sequencing; nearest-dot
    // fallback keeps custom configs safe).
    const handoffTo = (target: DotShapeName, targetIdx: number, atCell: number) => {
      const targetMask = masks.get(target)!;
      const canonical = routes.get(target)!;
      const startCell = targetMask[atCell]
        ? atCell
        : canonical.reduce(
            (best, cell) =>
              Math.hypot(
                (cell % MATRIX) - (atCell % MATRIX),
                Math.floor(cell / MATRIX) - Math.floor(atCell / MATRIX)
              ) <
              Math.hypot(
                (best % MATRIX) - (atCell % MATRIX),
                Math.floor(best / MATRIX) - Math.floor(atCell / MATRIX)
              )
                ? cell
                : best,
            canonical[0]
          );
      route = rotateRoute(canonical, startCell);
      playlistIdx = targetIdx;
      headPos = 0;
      stepsInShape = 0;
      seeking = null;
      seekSteps = 0;
      snapshotToFrom();
      setTargetMaps(targetMask, opacityBase, 1);
      if (startCell !== history[0]) {
        history.unshift(startCell);
        if (history.length > SNAKE_TAIL.length) history.length = SNAKE_TAIL.length;
      }
    };

    const settleToRest = () => {
      running_shape = false;
      playlistIdx = -1;
      seeking = null;
      snapshotToFrom();
      setTargetMaps(restMask, opacityPeak, 0);
    };

    const beginThinking = () => {
      const first = playlist[0];
      // Spawn the head on a dot shared between the rest logo and the first
      // shape — earliest such dot in the shape's canonical route.
      const canonical = routes.get(first)!;
      const spawn = canonical.find((cell) => restMask[cell]) ?? canonical[0];
      history.length = 0;
      history.unshift(spawn);
      tailFade = 1;
      running_shape = true;
      handoffTo(first, 0, spawn);
    };

    // Draw in device-pixel space with centers/radii snapped to whole device
    // pixels — dot positions never animate (only opacity), and unsnapped
    // fractional centers (e.g. 14px -> 2.8px pitch) blur every dot differently.
    // Light mode gets a size boost (snapped to half pixels): dark-on-light dots
    // read optically smaller than the same-size light-on-dark dots.
    const devCenter = (cell: number) => Math.round((cell + 0.5) * pitch * dpr);
    const devDotR =
      mode === "light"
        ? Math.max(1, Math.round(dotR * dpr * 1.15 * 2) / 2)
        : Math.max(1, Math.round(dotR * dpr));

    const draw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const t = smoothstep(blendT);
      for (let index = 0; index < MATRIX * MATRIX; index++) {
        let alpha = mix(baseFrom[index], baseTo[index], t);
        let cBlend = mix(blendFrom[index], blendTo[index], t);
        // Tail overlay from the head's recent history (trails through handoffs).
        if (tailFade > 0.01) {
          const d = history.indexOf(index);
          if (d >= 0 && d < SNAKE_TAIL.length) {
            const level = mix(opacityBase, opacityPeak, SNAKE_TAIL[d]) * tailFade;
            if (level > alpha) {
              alpha = level;
              cBlend = Math.max(cBlend, tailFade);
            }
          }
        }
        const row = Math.floor(index / MATRIX);
        const col = index % MATRIX;
        const x = devCenter(col);
        const y = devCenter(row);
        ctx.beginPath();
        if (alpha <= gridOpacity) {
          const ghostAlpha = gridOpacity * gridFade;
          if (ghostAlpha <= 0.004) continue;
          ctx.shadowBlur = 0;
          ctx.fillStyle = `rgba(${gridRgb[0]},${gridRgb[1]},${gridRgb[2]},${ghostAlpha.toFixed(3)})`;
          ctx.arc(x, y, devDotR, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        const rgb = mixRgb(restRgb[index], gridColors[index], cBlend);
        ctx.fillStyle = `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${alpha.toFixed(3)})`;
        const glowAlpha = alpha >= 0.6 ? ((alpha - 0.6) / 0.4) * glowFade : 0;
        if (glowAlpha > 0.01) {
          ctx.shadowColor = `rgba(${glowRgb[0]},${glowRgb[1]},${glowRgb[2]},${glowAlpha.toFixed(3)})`;
          ctx.shadowBlur = devDotR * 2.2;
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.arc(x, y, devDotR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    };

    const reduced =
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      draw();
      return;
    }

    let raf = 0;
    let running = false;
    let last = 0;

    // One metronome step: move the head one dot, then apply the transition
    // rules — (1) enough cycles? (2) on a shared dot? (3) hand off from it.
    const stepOnce = () => {
      headPos = (headPos + 1) % route.length;
      stepsInShape++;
      history.unshift(route[headPos]);
      if (history.length > SNAKE_TAIL.length) history.length = SNAKE_TAIL.length;

      // Every change of seek mode restarts the step budget, so each search gets
      // a full lap to find a shared dot before its fallback fires.
      if (!activeRef.current) {
        if (seeking !== "rest") {
          seeking = "rest";
          seekSteps = 0;
        }
      } else {
        if (seeking === "rest") {
          // Re-activated mid-settle: cancel the pending return to rest so a
          // quick off/on toggle carries on instead of restarting.
          seeking = null;
          seekSteps = 0;
        }
        if (seeking !== "next" && stepsInShape >= cyclesPerShape * route.length) {
          seeking = "next";
          seekSteps = 0;
        }
      }
      if (!seeking) return;

      seekSteps++;
      const headCell = route[headPos];
      if (seeking === "rest") {
        if (restMask[headCell] || seekSteps > route.length + 1) {
          settleToRest();
        }
      } else {
        const nextIdx = (playlistIdx + 1) % playlist.length;
        const nextMask = masks.get(playlist[nextIdx])!;
        if (nextMask[headCell] || seekSteps > route.length + 1) {
          handoffTo(playlist[nextIdx], nextIdx, headCell);
        }
      }
    };

    const frame = (now: number) => {
      const dt = Math.min(80, now - last);
      last = now;
      let keepGoing = true;

      // The ghost grid follows activity when gridAtRest is off; the glow always does.
      const gridTarget = gridAtRest || running_shape ? 1 : 0;
      if (gridFade < gridTarget) {
        gridFade = Math.min(gridTarget, gridFade + dt / blendMs);
      } else if (gridFade > gridTarget) {
        gridFade = Math.max(gridTarget, gridFade - dt / blendMs);
      }
      const glowTarget = running_shape ? 1 : 0;
      if (glowFade < glowTarget) {
        glowFade = Math.min(glowTarget, glowFade + dt / blendMs);
      } else if (glowFade > glowTarget) {
        glowFade = Math.max(glowTarget, glowFade - dt / blendMs);
      }

      if (!running_shape) {
        if (activeRef.current && playlist.length > 0) {
          beginThinking();
        } else {
          // Settling home: finish the crossfade, fade the tail + grid + glow, then stop.
          blendT = Math.min(1, blendT + dt / blendMs);
          tailFade = Math.max(0, tailFade - dt / blendMs);
          if (blendT >= 1 && tailFade <= 0 && gridFade === gridTarget && glowFade === 0) {
            keepGoing = false;
          }
        }
      }

      if (running_shape) {
        blendT = Math.min(1, blendT + dt / blendMs);
        stepClock += dt;
        while (stepClock >= stepMs && running_shape) {
          stepClock -= stepMs;
          stepOnce();
        }
      }

      draw();

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

    draw();
    wake();

    return () => {
      running = false;
      wakeRef.current = () => {};
      cancelAnimationFrame(raf);
    };
  }, [
    size,
    speed,
    restShape,
    playlistKey,
    cyclesPerShape,
    paletteKey,
    restColor,
    opacityBase,
    opacityPeak,
    mode,
    gridOpacity,
    gridAtRest,
  ]);

  return (
    <canvas
      ref={canvasRef}
      {...(decorative
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": ariaLabel ?? (active ? "Agent thinking" : "Agent") })}
      className={className}
      style={{ width: size, height: size, display: "block", ...style }}
    />
  );
}

/** The agent's monochrome logo. Use this rather than `palette="mono"`, which is invisible on light. */
export function AgentMonoLogo(props: Omit<AgentDotMatrixProps, "palette" | "restColor" | "mode">) {
  const mode = useThemeMode();
  const light = mode === "light";
  return (
    <AgentDotMatrix
      {...props}
      mode={mode}
      palette={light ? "monoLight" : "mono"}
      restColor={light ? "#1a1b1f" : "#d7d9dd"}
    />
  );
}
