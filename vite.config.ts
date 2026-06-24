import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // CR1: 浏览器跨域转发。把各 provider base_url 放进 .env.local 的
    // VITE_*_BASE_URL 时，若指向同源 /api/* 代理前缀，由 dev server 转发，
    // 避免浏览器 CORS。生产环境需各自部署侧反向代理。
    proxy: {
      "/api/claude": {
        target: process.env.VITE_CLAUDE_BASE_URL ?? "https://api.anthropic.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/claude/, ""),
      },
    },
  },
});
