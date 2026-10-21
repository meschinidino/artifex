import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFloorServer, type FloorServer } from "./index.ts";
import { authedClient, closeAllClients } from "./test-client.ts";
import { MASKED_TOKEN } from "../watcher/mask.ts";

let floor: FloorServer | undefined;
let repo = "";

afterEach(() => {
  closeAllClients();
  floor?.stop();
  floor = undefined;
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = "";
});

async function boot() {
  repo = mkdtempSync(join(tmpdir(), "artifex-lines-"));
  const numbered = Array.from({ length: 30 }, (_, i) => `code line ${i + 1}`);
  numbered[9] = `const API_KEY = "sk-live-should-mask";`;
  writeFileSync(join(repo, "a.ts"), `${numbered.join("\n")}\n`);
  writeFileSync(join(repo, ".env"), `API_KEY=sekret\n`);
  writeFileSync(join(repo, "b.bin"), new Uint8Array([0, 1, 2, 3]));
  floor = await createFloorServer({ repo, port: 0 });
  return authedClient(floor);
}

describe("get-lines round trip (ECL1)", () => {
  // Value: protects=evidence expansion reads (centered window,
  // edge clamps, radius cap, masking); fails_when=the range math,
  // the guards, or the mask breaks; why_new=clickable evidence.
  test("centers the window, clamps edges, caps radius, masks secrets", async () => {
    const { client } = await boot();
    const ask = async (msg: unknown) => {
      const mark = client.messages.length;
      client.send(msg as never);
      const got = await client.waitFor((m) => m.type === "lines" || m.type === "error", "lines", 10_000, mark);
      if (got.type !== "lines") throw new Error(`expected lines, got ${got.type}`);
      return got;
    };
    const mid = await ask({ v: 1, type: "get-lines", path: "a.ts", center: 15, radius: 2 });
    expect(mid.type).toBe("lines");
    expect(mid).toMatchObject({ path: "a.ts", center: 15, start: 13, total: 31 });
    expect(mid.lines).toHaveLength(5);
    expect(mid.lines[0]).toBe("code line 13");
    // Secret on file line 10 lands masked (numbering intact);
    // radius 0 floors to 1.
    const secret = await ask({ v: 1, type: "get-lines", path: "a.ts", center: 10, radius: 0 });
    expect(secret).toMatchObject({ start: 9, center: 10 });
    expect(secret.lines).toEqual(["code line 9", `const API_KEY = ${MASKED_TOKEN}`, "code line 11"]);
    // Top clamps to 1, bottom clamps to total, radius caps at 25.
    const top = await ask({ v: 1, type: "get-lines", path: "a.ts", center: 1 });
    expect(top).toMatchObject({ start: 1, center: 1 });
    expect(top.lines).toHaveLength(21);
    const bottom = await ask({ v: 1, type: "get-lines", path: "a.ts", center: 99, radius: 99 });
    expect(bottom).toMatchObject({ center: 31, start: 1 });
    expect(bottom.lines).toHaveLength(31);
  }, 30_000);

  test("file problems report lines-failed; malformed stays bad-message", async () => {
    const { client } = await boot();
    const askError = async (msg: unknown) => {
      const mark = client.messages.length;
      client.send(msg as never);
      return client.waitFor((m) => m.type === "error", "lines error", 10_000, mark) as Promise<{
        code: string;
        message: string;
      }>;
    };
    expect((await askError({ v: 1, type: "get-lines", path: "missing.ts", center: 1 })).code).toBe("lines-failed");
    expect((await askError({ v: 1, type: "get-lines", path: ".env", center: 1 })).code).toBe("lines-failed");
    expect((await askError({ v: 1, type: "get-lines", path: "b.bin", center: 1 })).code).toBe("lines-failed");
    expect((await askError({ v: 1, type: "get-lines", path: "a.ts", center: "3" })).code).toBe("bad-message");
    expect((await askError({ v: 1, type: "get-lines", center: 3 })).code).toBe("bad-message");
  }, 30_000);
});
