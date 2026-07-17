import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      },
    },
    server: {
      // Phase 1: 此 dev proxy 仅 dev 模式语法保留，生产路径已切到 /settings gateway
      // 浏览器直连（P02 anthropicAdapter/openaiCompatibleAdapter + D-13 Anthropic CORS
      // header anthropic-dangerous-direct-browser-access:true）。proxy 不删除以免破坏
      // dev 临时 mock 验证；production build 不含此 server.proxy 路径（vite build 仅产
      // pure client bundle，SC#3 干净检出）。
      proxy: {
        "/api/claude": {
          target: env.MODEL_PROXY_URL || "http://127.0.0.1:8788",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/claude/, ""),
        },
      },
    },
  };
});
