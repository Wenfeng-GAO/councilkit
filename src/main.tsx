import { router } from "@/app/router";
import { getAppRuntime, startRuntimeAudit } from "@/runtime/bootstrap";
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

// U6: 启动浏览器侧 Runtime（同源 RuntimeClient + Discussion Orchestrator 懒单例，
// display 桥接到 react-query 失效），再 fire-and-forget 跑一次 startup audit
// 收敛崩溃残留 —— 不 await，不阻塞首屏；失败仅 console.warn。
getAppRuntime({ queryClient });
startRuntimeAudit();

createRoot(container).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
