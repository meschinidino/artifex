import { helper } from "../util.ts";

test("helper works", () => {
  if (helper() !== "util") throw new Error("bad helper");
});
