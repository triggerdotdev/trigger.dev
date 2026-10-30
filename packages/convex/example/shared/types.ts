export type SampleId =
  | "forest"
  | "coast"
  | "mountains"
  | "city"
  | "desert"
  | "lake"
  | "dog"
  | "flowers"
  | "architecture"
  | "canyon";
export type PresetId = "balanced" | "compact" | "quality";
export type VariantKind = "hero" | "card" | "square";
export type ImageResult = {
  kind: VariantKind;
  width: number;
  height: number;
  bytes: number;
  format: "avif";
  url: string;
};
export type Job = {
  id: string;
  requestId?: string;
  sample: SampleId;
  prompt: string;
  preset: PresetId;
  createdAt: number;
  completedAt?: number;
  expiresAt: number;
  status: string;
  syncStatus: string;
  progress: number;
  stage: string;
  runId: string | null;
  realtimeEligible?: boolean;
  error: string | null;
  results: ImageResult[];
  inputBytes?: number;
  processingMs?: number;
};
export type Board = {
  jobs: Job[];
  quota: {
    used: number;
    limit: number;
    dailyUsed: number;
    dailyLimit: number;
    active: boolean;
    enabled: boolean;
    cooldownUntil: number;
  };
  turnstileSiteKey: string | null;
};
