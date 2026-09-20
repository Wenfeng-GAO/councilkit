import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { mapStartReviewError, parseStartReviewQuery } from "@/lib/start-review-hints";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { CliRunStartReviewRequest } from "@shared/runtime/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { DefaultReviewJury, type JuryStatus } from "./DefaultReviewJury";

export function StartReviewForm() {
  const { client } = getAppRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [juryStatus, setJuryStatus] = useState<JuryStatus>({
    ready: false,
    summary: "正在读取默认席位",
  });
  const query = parseStartReviewQuery(location.search);
  const against = query.against;
  const [pr, setPr] = useState(query.pr ?? "");
  const [repo, setRepo] = useState("");
  const [hint, setHint] = useState<{ text: string; copyCommand: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const next = parseStartReviewQuery(location.search);
    if (next.pr) setPr(next.pr);
  }, [location.search]);

  useEffect(() => {
    if (location.hash !== "#review") return;
    document.getElementById("review")?.scrollIntoView({ block: "start" });
    const input = document.getElementById("review-pr-url");
    if (input instanceof HTMLElement) input.focus();
  }, [location.hash]);

  const start = useMutation({
    mutationFn: () => {
      const body: CliRunStartReviewRequest = { pr: pr.trim() };
      const repoPath = repo.trim();
      if (repoPath.length > 0) body.repo = repoPath;
      if (against) body.against = against;
      return client.startCliReview(body);
    },
    onMutate: () => {
      setHint(null);
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["cli-runs"] });
      navigate(`/reports/${data.runId}`);
    },
    onError: (error) => {
      setHint(mapStartReviewError(error, pr));
    },
  });

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <form
      id="review"
      className="ck-review-composer"
      aria-labelledby="start-review-heading"
      aria-busy={start.isPending}
      onSubmit={(event) => {
        event.preventDefault();
        if (!start.isPending && juryStatus.ready) start.mutate();
      }}
    >
      <div className="ck-composer-heading">
        <div>
          <p className="ck-eyebrow">NEW REVIEW</p>
          <h2 id="start-review-heading">{against ? "对照复审" : "发起 PR 审查"}</h2>
        </div>
        <span className="ck-composer-note">
          {against ? `对照 ${against}` : "独立审查 · 对比汇总"}
        </span>
      </div>
      <fieldset disabled={start.isPending} className="ck-composer-fields">
        <TextInput
          id="review-pr-url"
          label="PR URL"
          value={pr}
          onChange={(event) => setPr(event.target.value)}
          required
          placeholder="粘贴 GitHub 或 AntCode PR 链接"
          autoComplete="off"
        />
        <DefaultReviewJury disabled={start.isPending} onStatusChange={setJuryStatus} />
        <details className="ck-review-advanced">
          <summary className="cursor-pointer select-none text-sm text-muted">
            高级 · 本地仓库
          </summary>
          <div className="mt-2">
            <TextInput
              id="review-repo-path"
              label="本地仓库路径"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="/abs/path/to/checkout"
              autoComplete="off"
              help="可选。自动定位失败时，指定此 PR 对应的本地仓库。"
            />
          </div>
        </details>
      </fieldset>
      <div className="ck-composer-footer">
        <p>{juryStatus.summary}</p>
        <Button
          className="ck-start-button"
          type="submit"
          disabled={start.isPending || !juryStatus.ready}
        >
          {start.isPending ? "正在启动…" : against ? "开始对照复审" : "开始审查"}
        </Button>
      </div>
      {hint ? (
        <div role="alert" className="flex flex-col gap-2 text-sm text-error">
          <p>{hint.text}</p>
          {hint.copyCommand ? (
            <button
              type="button"
              className="self-start text-xs text-accent hover:underline"
              aria-label={`复制命令 ${hint.copyCommand}`}
              onClick={() => void copy(hint.copyCommand as string)}
            >
              {copied ? "已复制" : `复制：${hint.copyCommand}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
