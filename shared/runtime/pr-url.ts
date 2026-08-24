/**
 * GitHub + AntCode PR URL parser shared by the CLI and Runtime Host.
 * Host preflight must use this module — never import from cli/src.
 */

const GITHUB_HOST = "github.com";
const ANTCODE_HOST = "code.alipay.com";

/** Safe AntCode project path segment (group/subgroup/project). */
const ANTCODE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function parseGitHubPrUrl(url: URL): { owner: string; repo: string; number: string } | null {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const pullIdx = segments.indexOf("pull");
  if (pullIdx !== 2 || segments.length < 4) return null;
  const owner = segments[0];
  const repo = segments[1];
  const number = segments[3];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo)) return null;
  if (!/^[0-9]+$/.test(number)) return null;
  return { owner, repo, number };
}

export function parseAntCodePrUrl(url: URL): { project: string; iid: string } | null {
  const segments = url.pathname.split("/").filter((s) => s.length > 0);
  const prIdx = segments.indexOf("pull_requests");
  if (prIdx < 1 || prIdx !== segments.length - 2) return null;
  const iid = segments[prIdx + 1];
  if (!/^[0-9]+$/.test(iid)) return null;
  const projectSegments = segments.slice(0, prIdx);
  if (!projectSegments.every((s) => ANTCODE_SEGMENT.test(s))) return null;
  return { project: projectSegments.join("/"), iid };
}

export function parseApplyPrUrl(pr: string): { kind: "github" | "antcode"; url: URL } | null {
  let url: URL;
  try {
    url = new URL(pr);
  } catch {
    return null;
  }
  if (url.host === GITHUB_HOST && parseGitHubPrUrl(url) !== null) {
    return { kind: "github", url };
  }
  if (url.host === ANTCODE_HOST && parseAntCodePrUrl(url) !== null) {
    return { kind: "antcode", url };
  }
  return null;
}

export function projectKeyFromPr(pr: string): string | null {
  const parsed = parseApplyPrUrl(pr);
  if (parsed === null) return null;
  if (parsed.kind === "github") {
    const gh = parseGitHubPrUrl(parsed.url);
    return gh ? `${gh.owner}/${gh.repo}` : null;
  }
  const ant = parseAntCodePrUrl(parsed.url);
  return ant ? ant.project : null;
}
