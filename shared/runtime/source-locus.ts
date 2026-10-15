/**
 * A source line is the number in a file:line citation (`retry.go:12`,
 * `retry.go:12-18`). A bare colon-number is not a line: `上限:3` and `12:30`
 * name a threshold or a clock, and must not become a locus.
 */
export const SOURCE_FILE_EXT = String.raw`[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}`;
export const FILE_LINE_CITATION_SOURCE = String.raw`((?:[\w.-]+\/)*${SOURCE_FILE_EXT}):(\d+)(?:-(\d+))?`;

export interface FileLineCitation {
  path: string;
  start: number;
  end: number;
}

export function normalizeSourcePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase();
}

export function parseFileLineCitations(text: string): FileLineCitation[] {
  const out: FileLineCitation[] = [];
  const seen = new Set<string>();
  const re = new RegExp(FILE_LINE_CITATION_SOURCE, "g");
  let match = re.exec(text);
  while (match) {
    const path = match[1];
    const start = Number(match[2]);
    const end = match[3] ? Number(match[3]) : start;
    if (path && Number.isFinite(start) && Number.isFinite(end)) {
      const key = `${normalizeSourcePath(path)}:${start}-${end}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ path, start, end });
      }
    }
    match = re.exec(text);
  }
  return out;
}
