import { cliLang } from "../cli-locale";

const INTERNAL_DRIVERS = new Set(["cld", "codex-model"]);
const DISPLAY_ORDER = ["grok", "kimi", "codex", "cursor-agent"] as const;

/** Public tool names derived from missingDrivers (single source). `cld` stays internal. */
export function publicMissingDrivers(missingDrivers: readonly string[]): string[] {
  const publicOnes = missingDrivers.filter((name) => !INTERNAL_DRIVERS.has(name));
  const ordered: string[] = DISPLAY_ORDER.filter((name) => publicOnes.includes(name));
  for (const name of publicOnes) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered;
}

export function noAiCliMessage(
  missingDrivers: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string {
  const tools = publicMissingDrivers(missingDrivers);
  const list = tools.join(cliLang(env) === "zh" ? "、" : ", ");
  if (cliLang(env) === "zh") {
    return `还没找到可用的 AI 命令行工具。装好并登录下面任意一个，再运行 \`councilkit init\`：${list}。也可以先运行 \`councilkit demo\` 看一份示例报告，不需要任何账号。`;
  }
  return `No AI CLI found yet. Install and log in to any one of: ${list} — then run \`councilkit init\`. Or try \`councilkit demo\` first, no account needed.`;
}
