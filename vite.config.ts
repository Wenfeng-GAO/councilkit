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
      },
    },
    server: {
      // CR1 模型路径(dev): 浏览器无法直连 antchat（claude binary 专有鉴权），
      // 故 dev 代理到本地 model-proxy（scripts/model-proxy.mjs），由它经
      // `cld ant glm5.2` 完成鉴权并返回 Anthropic SSE。生产需另行方案。
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

