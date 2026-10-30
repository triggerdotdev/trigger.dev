import type { SampleId, PresetId } from "./types";

export const SAMPLES: { id: SampleId; name: string; file: string; source: string }[] = [
  {
    id: "forest",
    name: "Forest",
    file: "/samples/forest.jpg",
    source: "https://images.unsplash.com/photo-1441974231531-c6227db76b6e",
  },
  {
    id: "coast",
    name: "Coast",
    file: "/samples/coast.jpg",
    source: "https://images.unsplash.com/photo-1518837695005-2083093ee35b",
  },
  {
    id: "mountains",
    name: "Mountains",
    file: "/samples/mountains.jpg",
    source: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e",
  },
  {
    id: "city",
    name: "City",
    file: "/samples/city.jpg",
    source: "https://images.unsplash.com/photo-1519501025264-65ba15a82390",
  },
  {
    id: "desert",
    name: "Desert",
    file: "/samples/desert.jpg",
    source: "https://images.unsplash.com/photo-1509316785289-025f5b846b35",
  },
  {
    id: "lake",
    name: "Lake",
    file: "/samples/lake.jpg",
    source: "https://images.unsplash.com/photo-1501785888041-af3ef285b470",
  },
  {
    id: "dog",
    name: "Dog",
    file: "/samples/dog.jpg",
    source: "https://images.unsplash.com/photo-1552053831-71594a27632d",
  },
  {
    id: "flowers",
    name: "Flowers",
    file: "/samples/flowers.jpg",
    source: "https://images.unsplash.com/photo-1490750967868-88aa4486c946",
  },
  {
    id: "architecture",
    name: "Architecture",
    file: "/samples/architecture.jpg",
    source: "https://images.unsplash.com/photo-1487958449943-2429e8be8625",
  },
  {
    id: "canyon",
    name: "Canyon",
    file: "/samples/canyon.jpg",
    source: "https://images.unsplash.com/photo-1473580044384-7ba9967e16a0",
  },
];
export const PRESETS: { id: PresetId; name: string; description: string; quality: number }[] = [
  { id: "balanced", name: "Balanced", description: "Good quality, smaller files", quality: 55 },
  {
    id: "compact",
    name: "Smallest files",
    description: "More compression for faster delivery",
    quality: 35,
  },
  { id: "quality", name: "Higher quality", description: "More detail, larger files", quality: 75 },
];
export const VARIANTS = [
  { kind: "hero" as const, label: "Hero", width: 1024, height: 768 },
  { kind: "card" as const, label: "Card", width: 800, height: 600 },
  { kind: "square" as const, label: "Square", width: 400, height: 400 },
];
export const MAX_JOBS = 500;
export const DAILY_JOB_LIMIT = 50;
export const PROMPT_LIMIT = 500;
export const RESULT_TTL_MS = 60 * 60_000;
export const MODEL_ID = "meta/muse-image-1.0";
export const MODEL_COST_USD = 0.01;
export const COOLDOWN_MS = 20_000;
export const PROCESSOR_VERSION = "muse-realtime-v2";
export const AVIF_EFFORT = 4;
