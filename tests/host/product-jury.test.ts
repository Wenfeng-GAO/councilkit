import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productJuryRoutes, runProductJuryCli } from "@host/routes/product-jury";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

it("registers a read-only product-jury route", () => {
  const routes = productJuryRoutes();
  expect(routes.map((route) => [route.method, route.pattern, route.auth])).toEqual([
    ["GET", "/api/v1/product-jury", "session"],
  ]);
});

describe("product-jury CLI bridge", () => {
  let home: string;
  const previous = process.env.COUNCILKIT_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ck-host-product-jury-"));
    process.env.COUNCILKIT_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, "COUNCILKIT_HOME");
    else process.env.COUNCILKIT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("surfaces a corrupt councils.json instead of claiming product-jury is missing", async () => {
    writeFileSync(join(home, "councils.json"), "{not json\n");
    await expect(runProductJuryCli()).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("councils.json is not valid JSON"),
    });
  }, 20_000);

  it("still tells the operator to init when product-jury is absent", async () => {
    await expect(runProductJuryCli()).rejects.toMatchObject({
      status: 400,
      message: "default product-jury is missing; run `councilkit init`",
    });
  }, 20_000);
});
