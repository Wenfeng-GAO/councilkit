/**
 * Locked report labels (#377). Colour is not the only difference:
 * spec violations are a solid red rectangle, no-spec majority is a red outline
 * pill, and single-seat notes are a grey dashed tag.
 */

export interface FindingDisplayMark {
  kind: "spec" | "consensus" | "pending";
  /** Exact visible label, e.g. 「违反规格 · AC-3」. */
  label: string;
  /** Grey line under a consensus tag. Null for the other kinds. */
  basis: string | null;
}

const CONSENSUS_QUALIFIER = /^多席一致\s*(\d+\/\d+)$/;
const PENDING_QUALIFIER = /待确认\s*·\s*(.+)$/;
const BASIS_LINE = /无规格依据，依据是\s*(\d+\/\d+)\s*席一致：\s*([^\n]+)/;
const SPEC_LABEL = /违反规格\s*·\s*([A-Za-z][A-Za-z0-9_-]*)/;
const SPEC_BASIS = /违反了规格里的\s*([A-Za-z][A-Za-z0-9_-]*)\s*[：:]\s*([^\n]+)/;
const INVARIANT_LINE = /(?:不变量|不变式|invariant)\s*[:：]\s*`?([A-Za-z][A-Za-z0-9_-]{0,40})`?/i;

export function findingDisplayMark(input: {
  qualifier?: string | null;
  text: string;
  sectionTitle?: string | null;
  invariantId?: string | null;
  contractClass?: "in_contract" | "out_of_spec" | null;
}): FindingDisplayMark | null {
  const qualifier = input.qualifier?.trim() ?? "";
  const text = input.text;
  const basis = BASIS_LINE.exec(text);
  const consensusQual = CONSENSUS_QUALIFIER.exec(qualifier);
  if (basis || consensusQual) {
    const ratio = consensusQual?.[1] ?? basis?.[1] ?? "";
    const names = basis?.[2]?.trim().replace(/[。．.]\s*$/, "") ?? "";
    const basisText =
      ratio.length > 0 && names.length > 0 ? `无规格依据，依据是 ${ratio} 席一致：${names}` : null;
    return {
      kind: "consensus",
      label: `多席一致 ${ratio}`.trim(),
      basis: basisText,
    };
  }
  const section = input.sectionTitle?.trim() ?? "";
  const pendingQual = PENDING_QUALIFIER.exec(qualifier) ?? PENDING_QUALIFIER.exec(text);
  if (section === "待确认" || pendingQual) {
    const seat = pendingQual?.[1]?.trim().replace(/[。．.]\s*$/, "") || "未署名";
    return { kind: "pending", label: `待确认 · ${seat}`, basis: null };
  }
  if (input.contractClass === "out_of_spec") return null;
  const explicit = SPEC_LABEL.exec(qualifier) ?? SPEC_LABEL.exec(text);
  const specBasis = SPEC_BASIS.exec(text);
  const invariant = input.invariantId?.trim() || INVARIANT_LINE.exec(text)?.[1]?.trim() || "";
  const actOn = /act-on|合同内/i.test(qualifier) || input.contractClass === "in_contract";
  const id = explicit?.[1] ?? specBasis?.[1] ?? (actOn ? invariant : "");
  if (!id) return null;
  if (!actOn && !explicit && !specBasis) return null;
  const acceptance = specBasis?.[2]?.trim().replace(/[。．.]\s*$/, "") ?? "";
  return {
    kind: "spec",
    label: `违反规格 · ${id}`,
    basis: acceptance.length > 0 ? `违反了规格里的 ${id}：${acceptance}` : null,
  };
}

export function textWithoutBasis(text: string, basis: string | null): string {
  if (!basis) return text;
  return text
    .replace(basis, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const LOCATION_LINE = /^位置\s*[:：]/;

/**
 * Keep a location line from collapsing into the title. Markdown treats a
 * single newline as a space, so that one boundary becomes a blank line.
 * Every other line keeps its break and its indentation: a table, a nested
 * list, or an indented code block must survive SafeMarkdown.
 */
export function findingMarkdown(text: string): string {
  const lines = text.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (/^(?:不变量|不变式|invariant)\s*[:：]/i.test(trimmed)) return [];
    if (/规格合同减法|合同内\s*Act On|不变量\s*ID/.test(line)) return [];
    return [line.replace(/[ \t]+$/g, "")];
  });
  while (lines.length > 0 && lines[0]?.trim().length === 0) lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim().length === 0) lines.pop();
  if (lines.length === 0) return "";
  const title = lines[0]?.trim() ?? "";
  const rest = lines.slice(1);
  let cursor = 0;
  while (cursor < rest.length && rest[cursor]?.trim().length === 0) cursor += 1;
  const location = rest[cursor];
  if (location && LOCATION_LINE.test(location.trim())) {
    const tail = rest
      .slice(cursor + 1)
      .join("\n")
      .replace(/^\n+/, "");
    const separated = `${title}\n\n${location.trim()}`;
    return tail.length > 0 ? `${separated}\n${tail}` : separated;
  }
  return [title, ...rest]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
