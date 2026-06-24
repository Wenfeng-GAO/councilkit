// 本地模型代理（DEV 验证用）：把 CouncilKit 的 Anthropic /v1/messages 请求
// 代理给 `cld ant glm5.2`（cld 能完成 antchat 网关鉴权，浏览器/curl 不能直连）。
// 输出 Anthropic SSE 格式，app 的 stream.ts 无需改动。
// 生产环境不适用——仅 dev 验证模型连通性与端到端流程。
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

const PORT = Number(process.env.MODEL_PROXY_PORT ?? 8788);

function buildPrompt(parsed) {
  const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
  const sys = typeof parsed.system === "string" ? parsed.system : "";
  const convo = msgs
    .map((m) => `[${m.role === "assistant" ? "assistant" : "user"}] ${m.content}`)
    .join("\n\n");
  return sys ? `${sys}\n\n${convo}` : convo;
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400).end("bad json");
      return;
    }
    const prompt = buildPrompt(parsed);
    // 干净 cwd 避免 CLAUDE.md 污染；CLAUDE_CONFIG_DIR 指 temp 以跳过全局指令
    const cwd = mkdtempSync(path.join(tmpdir(), "ck-claude-"));
    const child = spawn("cld", ["ant", "glm5.2", "--print", prompt], {
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: cwd },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => process.stderr.write(`[cld] ${d}`));
    child.on("error", (e) => {
      res.writeHead(502);
      res.end(`spawn error: ${e.message}`);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        res.writeHead(502);
        res.end(`cld exit ${code}`);
        return;
      }
      const text = out.trim();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Anthropic 兼容 SSE：一个 text delta 后 [DONE]
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[model-proxy] listening on http://127.0.0.1:${PORT} (→ cld ant glm5.2)`);
});
