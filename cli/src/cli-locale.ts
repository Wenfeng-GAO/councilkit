/**
 * CLI copy locale. Designer-locked strings (CLI-10) ship zh + en; pick from
 * the process locale. Unset locale follows the product default (zh).
 */
export function cliLang(env: NodeJS.ProcessEnv = process.env): "zh" | "en" {
  const raw = [env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  if (raw.length === 0) return "zh";
  if (/(?:^|[._\s-])zh(?:[._\s-]|$)/i.test(raw) || /^zh/i.test(raw.trim())) return "zh";
  return "en";
}
