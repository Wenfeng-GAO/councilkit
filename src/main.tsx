import { router } from "@/app/router";
import { runStartupMigration } from "@/lib/gateway-migrate";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import "@/styles/globals.css";

const queryClient = new QueryClient();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found");
}

// D-03: 启动期跑占位 gateway 迁移（旧 agent.model 标签 → 真实 model id + gatewayId 回填）。
// fire-and-forget —— 不 await，避免阻塞首屏；runStartupMigration 内部吞错 console.warn。
runStartupMigration();

createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
