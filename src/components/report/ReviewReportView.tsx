import { SafeMarkdown } from "@/components/markdown/SafeMarkdown";
import {
  type ParsedReviewReport,
  type ReviewAttemptRow,
  type ReviewFinding,
  type ReviewSection,
  splitH3Blocks,
} from "@/lib/review-report";
import { useEffect, useState } from "react";
import "@/styles/report.css";

const VERDICT_LABEL: Record<NonNullable<ParsedReviewReport["verdict"]>, string> = {
  approve: "Approve",
  "changes-requested": "Changes requested",
  comment: "Comment",
};

const SEVERITY_LABEL: Record<NonNullable<ReviewFinding["severity"]>, string> = {
  critical: "致命",
  major: "重大",
  minor: "次要",
  nit: "琐碎",
};

export function ReviewReportView({ report }: { report: ParsedReviewReport }) {
  const [active, setActive] = useState(report.sections[0]?.id ?? "");

  useEffect(() => {
    if (report.sections.length === 0) return;
    const nodes = report.sections
      .map((section) => document.getElementById(section.id))
      .filter((node): node is HTMLElement => node !== null);
    if (nodes.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setActive(visible.target.id);
      },
      { rootMargin: "0px 0px -62% 0px", threshold: [0.1, 0.25, 0.5] },
    );
    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, [report.sections]);

  return (
    <div className="ck-report">
      <header className="mb-8">
        <p className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass">
          Jury report
        </p>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-display text-[2rem] leading-none tracking-tight text-parchment sm:text-[2.4rem]">
            {report.title}
          </h1>
          {report.verdict ? (
            <span className={`ck-verdict ck-verdict-${verdictClass(report.verdict)}`}>
              {VERDICT_LABEL[report.verdict]}
            </span>
          ) : null}
        </div>
        {report.meta.Task ? (
          <div className="ck-doc mt-4 max-w-3xl text-sm text-muted">
            <SafeMarkdown content={linkifyHttps(report.meta.Task)} />
          </div>
        ) : null}
        <dl className="mt-5 grid gap-2 text-xs text-muted sm:grid-cols-2">
          {metaLine("Run", report.meta.Run, true)}
          {metaLine("Status", report.meta.Status)}
          {metaLine("Aggregator", report.meta.Aggregator)}
          {metaLine("Started", formatStamp(report.meta.Started))}
          {metaLine("Ended", formatStamp(report.meta.Ended))}
          {report.meta.Focus ? metaLine("Focus", report.meta.Focus) : null}
          {report.meta.Reason ? metaLine("Reason", report.meta.Reason) : null}
        </dl>
      </header>

      {report.attempts.length > 0 ? (
        <section className="mb-10" aria-labelledby="ck-roster">
          <h2
            id="ck-roster"
            className="font-command text-[0.68rem] uppercase tracking-[0.16em] text-brass"
          >
            席位
          </h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {report.attempts.map((attempt) => (
              <AttemptCard key={`${attempt.name}-${attempt.driver}`} attempt={attempt} />
            ))}
          </ul>
        </section>
      ) : null}

      {report.preface ? (
        <SafeMarkdown className="mb-8 text-sm" variant="document" content={report.preface} />
      ) : null}

      {report.sections.length > 0 ? (
        <div className="grid gap-8 lg:grid-cols-[11rem_minmax(0,1fr)]">
          <nav className="ck-toc lg:sticky lg:top-6 lg:self-start" aria-label="报告章节">
            <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
              {report.sections.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    aria-current={active === section.id ? "true" : undefined}
                    className="block whitespace-nowrap border border-transparent px-2 py-1 text-xs text-muted hover:text-fg"
                  >
                    {section.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex min-w-0 flex-col gap-8">
            {report.sections.map((section) => (
              <SectionBlock key={section.id} section={section} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AttemptCard({ attempt }: { attempt: ReviewAttemptRow }) {
  const ok = attempt.result === "ok";
  return (
    <li className="border border-edge bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-fg">{attempt.name}</p>
        <span
          className={
            ok
              ? "ck-seat-ok font-command text-[0.68rem]"
              : "ck-seat-fail font-command text-[0.68rem]"
          }
        >
          {ok ? "ok" : attempt.result}
        </span>
      </div>
      <p className="mt-1 font-command text-[0.68rem] text-muted">{attempt.driver}</p>
      <p className="mt-2 text-xs text-muted">
        {attempt.duration}
        <span className="mx-1.5 text-edge">·</span>
        {attempt.tools === "无过程数据" ? "无过程数据" : `工具 ${attempt.tools}`}
      </p>
    </li>
  );
}

function SectionBlock({ section }: { section: ReviewSection }) {
  const appendix = section.id.startsWith("附录") || section.title.startsWith("附录");
  return (
    <section id={section.id} className="scroll-mt-6">
      <div className="mb-3 flex items-center gap-3">
        <h2 className="font-display text-xl text-parchment">{section.title}</h2>
        <div className="h-px flex-1 bg-gradient-to-r from-[var(--color-brass-dim)] to-transparent" />
      </div>
      {section.title === "结论" ? <VerdictBody body={section.body} /> : null}
      {section.title === "过程对比" ? (
        <ProcessBody body={section.body} />
      ) : appendix ? (
        <AppendixBody body={section.body} />
      ) : section.title === "分歧" ? (
        <DisagreementBody body={section.body} />
      ) : section.groups?.some((group) => group.title.length > 0) ? (
        <GroupedFindings groups={section.groups ?? []} />
      ) : section.findings?.some((finding) => finding.severity) ? (
        <FindingList findings={section.findings} sectionId={section.id} />
      ) : section.title === "结论" ? (
        <SafeMarkdown
          className="text-sm"
          variant="document"
          content={stripVerdictLine(section.body)}
        />
      ) : (
        <SafeMarkdown className="text-sm" variant="document" content={section.body} />
      )}
    </section>
  );
}

interface ProcessRow {
  name: string;
  driver: string;
  duration: string;
  tools: string | null;
  commands: string[];
}

function parseProcessLine(line: string): ProcessRow | null {
  const match = /^(.+?) \((.+?)\)(?: \[reused\])? — (.+)$/.exec(line);
  if (!match) return null;
  const rest = match[3];
  if (rest.includes("无过程数据")) {
    return {
      name: match[1],
      driver: match[2],
      duration: rest.replace(/\s*—\s*无过程数据$/, ""),
      tools: null,
      commands: [],
    };
  }
  const tools = /^(.+?) — 工具调用 (\d+) 次(?: — (.+))?$/.exec(rest);
  if (!tools) {
    return { name: match[1], driver: match[2], duration: rest, tools: null, commands: [] };
  }
  const commands = (tools[3] ?? "")
    .split("; ")
    .map((item) => item.replace(/^`/, "").replace(/`$/, "").trim())
    .filter((item) => item.length > 0);
  return {
    name: match[1],
    driver: match[2],
    duration: tools[1],
    tools: tools[2],
    commands,
  };
}

function ProcessBody({ body }: { body: string }) {
  const notes: string[] = [];
  const rows: ProcessRow[] = [];
  for (const line of body.split("\n")) {
    if (line.startsWith("> ")) {
      notes.push(line.slice(2).trim());
      continue;
    }
    if (!line.startsWith("- ")) continue;
    const row = parseProcessLine(line.slice(2).trim());
    if (row) rows.push(row);
  }
  if (rows.length === 0) {
    return <SafeMarkdown className="text-sm" variant="document" content={body} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {notes.map((note) => (
        <p
          key={note}
          className="border-l-2 border-[var(--color-brass)] bg-surface px-3 py-2 text-xs text-muted"
        >
          {note}
        </p>
      ))}
      {rows.map((row) => (
        <article
          key={`${row.name}-${row.driver}`}
          className="border border-edge bg-surface px-4 py-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-fg">{row.name}</p>
            <p className="font-command text-[0.68rem] text-muted">
              {row.duration}
              {row.tools ? ` · 工具 ${row.tools}` : " · 无过程数据"}
            </p>
          </div>
          <p className="mt-1 font-command text-[0.68rem] text-muted">{row.driver}</p>
          {row.commands.length > 0 ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-brass">
                查看 {row.commands.length} 条命令
              </summary>
              <ol className="mt-2 flex list-decimal flex-col gap-1 pl-4 font-command text-[0.68rem] leading-5 text-parchment">
                {row.commands.map((command) => (
                  <li key={command} className="break-all">
                    {command}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function AppendixBody({ body }: { body: string }) {
  const blocks = splitH3Blocks(body);
  if (blocks.length === 0) {
    return <SafeMarkdown className="text-sm" variant="document" content={body} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block) =>
        block.title.length === 0 ? (
          <SafeMarkdown
            key={`intro-${block.body.slice(0, 48)}`}
            className="text-sm"
            variant="document"
            content={block.body}
          />
        ) : (
          <details key={block.title} className="border border-edge bg-surface">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-fg">
              {block.title}
            </summary>
            <div className="border-t border-edge px-4 py-3">
              <SafeMarkdown className="text-sm" variant="document" content={block.body} />
            </div>
          </details>
        ),
      )}
    </div>
  );
}

function FindingList({
  findings,
  sectionId,
}: {
  findings: ReviewFinding[];
  sectionId: string;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {findings.map((finding) => (
        <FindingCard
          key={`${sectionId}-${finding.severity}-${finding.text.slice(0, 64)}`}
          finding={finding}
        />
      ))}
    </ul>
  );
}

function GroupedFindings({
  groups,
}: {
  groups: NonNullable<ReviewSection["groups"]>;
}) {
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <div key={group.title || "ungrouped"}>
          {group.title ? (
            <h3 className="mb-3 font-command text-[0.72rem] uppercase tracking-[0.14em] text-brass">
              {group.title}
            </h3>
          ) : null}
          <FindingList findings={group.findings} sectionId={group.title || "group"} />
        </div>
      ))}
    </div>
  );
}

function DisagreementBody({ body }: { body: string }) {
  const items = parseDisagreements(body);
  if (items === null) {
    return <SafeMarkdown className="text-sm" variant="document" content={body} />;
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.title || item.body.slice(0, 48)} className="ck-finding ck-finding-nit">
          {item.title ? (
            <p className="mb-2 font-command text-[0.72rem] uppercase tracking-[0.14em] text-brass">
              {item.title}
            </p>
          ) : null}
          <SafeMarkdown className="text-sm" variant="document" content={item.body} />
        </li>
      ))}
    </ul>
  );
}

function parseDisagreements(body: string): Array<{ title: string; body: string }> | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("- ")) return null;
  const items: Array<{ title: string; body: string }> = [];
  let current: string[] = [];
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("- ")) {
      if (current.length > 0) items.push(asDisagreement(current.join("\n")));
      current = [line.slice(2)];
      continue;
    }
    if (current.length === 0) return null;
    current.push(line);
  }
  if (current.length > 0) items.push(asDisagreement(current.join("\n")));
  return items.length > 0 ? items : null;
}

function asDisagreement(item: string): { title: string; body: string } {
  const match = /^\*\*(.+?)\*\*[：:]?\s*([\s\S]*)$/.exec(item.trim());
  if (!match) return { title: "", body: item.trim() };
  return { title: match[1].trim(), body: match[2].trim() };
}

function FindingCard({ finding }: { finding: ReviewFinding }) {
  const tone = finding.severity ?? "nit";
  return (
    <li className={`ck-finding ck-finding-${tone}`}>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {finding.severity ? (
          <span className={`ck-sev ck-sev-${finding.severity}`}>
            {SEVERITY_LABEL[finding.severity]}
            <span className="ck-sev-en">{finding.severity}</span>
          </span>
        ) : null}
        {finding.qualifier ? <span className="ck-sev-note">{finding.qualifier}</span> : null}
      </div>
      <SafeMarkdown className="text-sm" variant="document" content={finding.text} />
    </li>
  );
}

function VerdictBody({ body }: { body: string }) {
  const match = /\b(approve|changes-requested|comment)\b/.exec(body);
  if (!match?.[1]) return null;
  const verdict = match[1] as NonNullable<ParsedReviewReport["verdict"]>;
  return (
    <p className={`ck-verdict ck-verdict-${verdictClass(verdict)} mb-4`}>
      {VERDICT_LABEL[verdict]}
    </p>
  );
}

function stripVerdictLine(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^\s*(approve|changes-requested|comment)\s*$/.test(line))
    .join("\n")
    .trim();
}

function metaLine(label: string, value: string | undefined, mono = false) {
  if (!value) return null;
  return (
    <div>
      <dt className="font-command uppercase tracking-[0.12em] text-brass">{label}</dt>
      <dd className={`mt-0.5 text-fg ${mono ? "font-command" : ""}`}>{value}</dd>
    </div>
  );
}

function formatStamp(value: string | undefined): string | undefined {
  if (!value) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function verdictClass(verdict: NonNullable<ParsedReviewReport["verdict"]>): string {
  if (verdict === "changes-requested") return "changes";
  return verdict;
}

function linkifyHttps(text: string): string {
  return text.replace(/(https:\/\/[^\s<]+)/g, "[$1]($1)");
}
