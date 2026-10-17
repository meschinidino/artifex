import { helper } from "./util.ts";
import { load } from "../lib/store.ts";

export function main(): string {
  return `${helper()}-${load()}`;
}
