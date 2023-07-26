export type GenericTable = {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
};

export type GenericUpdatableView = {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
};

export type GenericNonUpdatableView = {
  Row: Record<string, unknown>;
};

export type GenericView = GenericUpdatableView | GenericNonUpdatableView;

export type GenericFunction = {
  Args: Record<string, unknown>;
  Returns: unknown;
};

export type GenericSchema = {
  Tables: Record<string, GenericTable>;
  Views: Record<string, GenericView>;
  Functions: Record<string, GenericFunction>;
};
