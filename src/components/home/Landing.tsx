import { type CSSProperties, type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import "@/styles/landing.css";

const INIT_CMD = "councilkit init";
const REVIEW_CMD = "councilkit review <url>";
const APPLY_CMD = "councilkit apply --run <id>";
const RUN_CMD = "councilkit run --council <name> --rounds 2";
const START_CMD = "pnpm start";

const SEATS = [
  {
    area: "ck-seat-n",
    name: "安全",
    driver: "cld · Claude",
    color: "#f74f6e",
    id: "review-security",
  },
  {
    area: "ck-seat-w",
    name: "正确性",
    driver: "codex",
    color: "#4f6ef7",
    id: "review-correctness",
  },
  {
    area: "ck-seat-e",
    name: "可维护",
    driver: "kimi",
    color: "#4ff76e",
    id: "review-maintainability",
  },
  {
    area: "ck-seat-s",
    name: "对抗",
    driver: "grok",
    color: "#a78bfa",
    id: "review-adversarial",
  },
] as const;

export function Landing() {
  return (
    <section className="ck-landing px-6 pb-10 pt-8 sm:px-8 sm:pt-10">
      <a
        href="#rooms"
        className="sr-only focus:not-sr-only focus:absolute focus:left-6 focus:top-4 focus:z-10 focus:bg-surface focus:px-3 focus:py-2"
      >
        跳到讨论房间
      </a>

      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-12 lg:items-center lg:gap-12">
        <div className="lg:col-span-7">
          <p className="ck-kicker">Local-first council</p>
          <h1 className="ck-display mt-4 max-w-[14ch] text-[2.35rem] sm:text-[3.15rem]">
            让模型互相看见，
            <br />
            <em className="not-italic sm:italic">再下结论</em>
          </h1>
          <p className="mt-5 max-w-xl text-[0.95rem] leading-7 text-muted">
            CouncilKit 把已经登录的本机 CLI
            组成讨论席或陪审团。它们要么轮流挑战彼此，要么在隔离目录里独立审查。产物是一份可归档的
            Markdown，不是又一个聊天窗口。
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link to="/rooms/new" className="ck-cta ck-cta-primary">
              去新建房间
            </Link>
            <Link to="/reports" className="ck-cta ck-cta-ghost">
              查看 CLI 报告
            </Link>
            <Link to="/settings" className="ck-cta ck-cta-ghost">
              检查 Host
            </Link>
          </div>
          <p className="mt-4 max-w-xl text-xs leading-5 text-muted">
            浏览器从不直连模型。Discuss / <code className="font-command">run</code> 需要 Runtime
            Host；<code className="font-command">review</code> 不经 Host。两边数据不互通。
          </p>
        </div>
        <div className="lg:col-span-5">
          <Chamber />
        </div>
      </div>

      <div className="mx-auto mt-14 max-w-6xl">
        <SectionLabel>两种开庭方式</SectionLabel>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <article className="ck-mode ck-mode-discuss">
            <p className="font-command text-[0.62rem] uppercase tracking-[0.16em] text-accent">
              Discuss
            </p>
            <h2 className="ck-display mt-2 text-2xl text-parchment">讨论：共享上下文，按序发言</h2>
            <div className="ck-mode-flow" aria-hidden="true">
              <span className="ck-chip">焦点</span>
              <span className="ck-arrow">→</span>
              <span className="ck-chip">席位 A</span>
              <span className="ck-arrow">→</span>
              <span className="ck-chip">席位 B</span>
              <span className="ck-arrow">→</span>
              <span className="ck-chip">Reporter</span>
            </div>
            <p className="text-sm leading-6 text-muted">
              每人看得见前面所有发言，可以反驳、补充、改口。固定轮次后 Reporter
              写出九段决策报告。适合方案取舍、设计争议、需要互相校正的判断。
            </p>
            <p className="mt-4 text-xs text-muted">
              浏览器「新建房间」，或 CLI <code className="font-command">run</code>
              。都要先有 Host。
            </p>
          </article>
          <article className="ck-mode ck-mode-jury">
            <p className="font-command text-[0.62rem] uppercase tracking-[0.16em] text-brass">
              Jury
            </p>
            <h2 className="ck-display mt-2 text-2xl text-parchment">陪审：隔离并行，再对比汇总</h2>
            <div className="ck-mode-flow" aria-hidden="true">
              <span className="ck-chip">Attempt</span>
              <span className="ck-chip">Attempt</span>
              <span className="ck-chip">Attempt</span>
              <span className="ck-arrow">→</span>
              <span className="ck-chip">Aggregator</span>
            </div>
            <p className="text-sm leading-6 text-muted">
              席位互相看不见。各自在隔离目录里独立审完，Aggregator 再对照分歧。适合 PR
              审查、找漏洞，避免先发言者带节奏。
            </p>
            <p className="mt-4 text-xs text-muted">
              <code className="font-command">councilkit review</code>
              ，不经 Host，浏览器可关。默认陪审团是 <code className="font-command">pr-jury</code>
              。报告落地后用 <code className="font-command">apply</code> 在隔离目录改同一条 PR（默认
              Grok，默认 push）。
            </p>
          </article>
        </div>
      </div>

      <div className="mx-auto mt-14 max-w-6xl">
        <SectionLabel>如何使用</SectionLabel>
        <ol className="mt-4 flex flex-col gap-3">
          <HowToStep index="01" title="发现本机 CLI，写下默认陪审团">
            <p>
              扫描 PATH 上的 <code className="font-command">cld</code> /{" "}
              <code className="font-command">codex</code> /{" "}
              <code className="font-command">kimi</code> /{" "}
              <code className="font-command">grok</code>
              ，写入安全、正确性、可维护席位；若有 Grok 再加对抗席。Reporter 默认是正确性席。
            </p>
            <CommandCopy value={INIT_CMD} />
          </HowToStep>
          <HowToStep index="02" title="选一种方式开庭">
            <p>
              审 PR 或独立任务走 Jury。需要互相看见、来回校正走 Discuss。
              <code className="font-command">review</code> 不需要 Host；
              <code className="font-command"> run</code> 与浏览器房间需要{" "}
              <code className="font-command">{START_CMD}</code>。
            </p>
            <CommandCopy value={REVIEW_CMD} />
            <CommandCopy value={APPLY_CMD} />
            <CommandCopy value={RUN_CMD} />
          </HowToStep>
          <HowToStep index="03" title="读报告，不要再自己拼结论">
            <p>
              CLI 报告落在 <code className="font-command">~/.config/councilkit/runs/</code>
              。Host 在线时，浏览器「报告」页只读打开同一份{" "}
              <code className="font-command">report.md</code>
              。浏览器房间的结论仍在各自房间里。
            </p>
            <div className="flex flex-wrap gap-3">
              <Link to="/reports" className="ck-cta ck-cta-ghost">
                打开报告库
              </Link>
              <Link to="/rooms/new" className="ck-cta ck-cta-ghost">
                从浏览器开讨论
              </Link>
            </div>
          </HowToStep>
        </ol>
      </div>

      <div className="mx-auto mt-14 max-w-6xl">
        <SectionLabel>本机席位</SectionLabel>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {SEATS.map((seat) => (
            <li key={seat.id} className="border border-edge bg-surface px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="ck-pip" style={pipStyle(seat.color)} />
                {seat.name}
              </p>
              <p className="mt-1 font-command text-[0.68rem] text-muted">{seat.driver}</p>
              <p className="mt-2 font-command text-[0.62rem] text-brass">{seat.id}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">
          不存 API Key。凭据由各 CLI 自己管理；CouncilKit 只调度已经登录的本机安装。
        </p>
      </div>
    </section>
  );
}

function pipStyle(color: string): CSSProperties {
  return { background: color, boxShadow: `0 0 0 2px ${color}40` };
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="font-command text-[0.68rem] uppercase tracking-[0.18em] text-brass">
        {children}
      </h2>
      <div className="ck-rule flex-1" />
    </div>
  );
}

function Chamber() {
  return (
    <div
      className="ck-chamber border border-edge bg-bg"
      role="img"
      aria-label="四个席位围着一份卷宗：安全、正确性、可维护、对抗。默认陪审团名为 pr-jury。"
    >
      <svg className="ck-chamber-lines" viewBox="0 0 100 100" aria-hidden="true">
        <line x1="50" y1="0" x2="50" y2="38" />
        <line x1="0" y1="50" x2="32" y2="50" />
        <line x1="68" y1="50" x2="100" y2="50" />
        <line x1="50" y1="62" x2="50" y2="100" />
      </svg>
      {SEATS.map((seat) => (
        <div key={seat.id} className={`ck-seat ${seat.area}`}>
          <p className="ck-seat-name">
            <span className="ck-pip" style={pipStyle(seat.color)} />
            {seat.name}
          </p>
          <p className="ck-seat-meta">{seat.driver}</p>
        </div>
      ))}
      <div className="ck-docket">
        <p className="ck-docket-label">Docket</p>
        <p className="ck-docket-title">pr-jury</p>
        <p className="ck-docket-sub">九段 Markdown · report.md</p>
      </div>
    </div>
  );
}

function HowToStep({
  index,
  title,
  children,
}: {
  index: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="ck-howto-row grid gap-4 border border-edge bg-surface px-4 py-4 sm:grid-cols-[auto_1fr] sm:px-5">
      <span className="ck-step-index" aria-hidden="true">
        {index}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-fg">{title}</h3>
        <div className="mt-2 flex flex-col gap-2 text-sm leading-6 text-muted">{children}</div>
      </div>
    </li>
  );
}

function CommandCopy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="ck-cmd">
      <pre>
        <code>{value}</code>
      </pre>
      <button type="button" onClick={() => void copy()} aria-label={`复制命令 ${value}`}>
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}
