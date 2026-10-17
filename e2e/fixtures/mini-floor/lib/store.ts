import type { Store } from "./types.ts";

export function load(): string {
  const s: Store = { name: "store" };
  return s.name;
}
