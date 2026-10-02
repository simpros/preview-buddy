export type Result<T, E extends string = string> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: E; detail?: string };
