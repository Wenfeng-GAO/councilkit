import { expect, it } from "vitest";
import { productJuryRoutes } from "@host/routes/product-jury";

it("registers a read-only product-jury route", () => {
  const routes = productJuryRoutes();
  expect(routes.map((route) => [route.method, route.pattern, route.auth])).toEqual([
    ["GET", "/api/v1/product-jury", "session"],
  ]);
});
