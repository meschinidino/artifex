import { describe, expect, test } from "bun:test";
import { createLiveArca, createStubArca } from "./toaster-arca.ts";

describe("toaster-arca", () => {
  test("stub status is canned OK and marked simulated", async () => {
    const arca = createStubArca();
    expect(arca.kind).toBe("stub");
    expect(arca.client).toBeUndefined();
    await expect(arca.status()).resolves.toEqual({
      appServer: "OK",
      dbServer: "OK",
      authServer: "OK",
      stub: true,
    });
  });

  test("live transport fails closed without cert+key", () => {
    expect(() =>
      createLiveArca({ cuit: 20111111112, cert: "", key: "" }),
    ).toThrow("needs cert+key");
    expect(() =>
      createLiveArca({ cuit: 20111111112, cert: "x", key: "" }),
    ).toThrow("needs cert+key");
  });

  test("live transport constructs under bun (no network on construct)", () => {
    const arca = createLiveArca({
      cuit: 20111111112,
      cert: "DUMMY",
      key: "DUMMY",
    });
    expect(arca.kind).toBe("live");
    expect(arca.client).toBeDefined();
  });
});
