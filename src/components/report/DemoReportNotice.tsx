/**
 * Amber sample-data tag and banner, chosen by run type. Shows only the
 * current UI language (designer, #295); the app is Chinese-only until the
 * English UI mode lands, so `en` is kept here ready for it.
 *
 * Review copy is locked by the UX audit (/workspace/ck-ux-audit/report.md ③):
 * tag row 「◆ 示例数据｜🔒 只读审查」, banner text, and the CTA
 * 「接入真实 AI，审我自己的 PR →」, which only opens the Settings tool list
 * (CMP-D1); it never starts a review.
 *
 * Discussion copy (B4, 产品/设计师): no 「🔒 只读审查」 tag, its own text, and
 * the CTA opens 新建讨论 (never the review entry).
 */
export type DemoNoticeKind = "review" | "discuss";

export interface DemoNoticeCopy {
  tag: string;
  readonlyTag: string | null;
  lead: string;
  body: string;
  cta: string;
  href: string;
}

export const DEMO_NOTICE_COPY: Record<DemoNoticeKind, { zh: DemoNoticeCopy; en: DemoNoticeCopy }> =
  {
    review: {
      zh: {
        tag: "◆ 示例数据",
        readonlyTag: "🔒 只读审查",
        lead: "这是示例报告。",
        body: "内容由内置示例 AI 生成，不代表真实模型的判断，也没有读取你的代码。",
        cta: "接入真实 AI，审我自己的 PR →",
        href: "/settings",
      },
      en: {
        tag: "◆ Sample data",
        readonlyTag: "🔒 Read-only review",
        lead: "This is a sample report.",
        body: "It was written by the built-in sample AI. It is not a real model's judgment, and it did not read your code.",
        cta: "Connect a real AI and review my own PR →",
        href: "/settings",
      },
    },
    discuss: {
      zh: {
        tag: "◆ 示例数据",
        readonlyTag: null,
        lead: "这是示例讨论报告。",
        body: "发言和结论都由内置示例 AI 生成，不代表真实模型的判断。",
        cta: "接入真实 AI，发起一场讨论 →",
        href: "/rooms/new",
      },
      en: {
        tag: "◆ Sample data",
        readonlyTag: null,
        lead: "This is a sample discussion report.",
        body: "The messages and the conclusion were written by the built-in sample AI. They are not a real model's judgment.",
        cta: "Connect a real AI and start a discussion →",
        href: "/rooms/new",
      },
    },
  };

/** Discussion runs (`councilkit run`, incl. slow-gen) get the discussion copy;
 * everything else keeps the review copy. */
export function demoNoticeKind(runKind: string | null | undefined): DemoNoticeKind {
  return runKind === "discuss" ? "discuss" : "review";
}

export function DemoReportNotice({ kind = "review" }: { kind?: DemoNoticeKind }) {
  const copy = DEMO_NOTICE_COPY[kind].zh;
  return (
    <aside className="ck-demo-banner" role="note" aria-label="示例数据">
      <p className="ck-demo-banner-tags">
        <span className="ck-demo-tag">{copy.tag}</span>
        {copy.readonlyTag ? <span className="ck-readonly-tag">{copy.readonlyTag}</span> : null}
      </p>
      <p>
        <strong>{copy.lead}</strong>
        {copy.body}
      </p>
      <p>
        <a className="ck-demo-banner-cta" href={copy.href}>
          {copy.cta}
        </a>
      </p>
    </aside>
  );
}
