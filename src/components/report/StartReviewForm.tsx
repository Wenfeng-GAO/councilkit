import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { mapStartReviewError } from "@/lib/start-review-hints";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

export function StartReviewForm() {
  const { client } = getAppRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [pr, setPr] = useState("");
  const [repo, setRepo] = useState("");
  const [hint, setHint] = useState<{ text: string; copyCommand: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (location.hash !== "#review") return;
    document.getElementById("review")?.scrollIntoView({ block: "start" });
    const input = document.getElementById("review-pr-url");
    if (input instanceof HTMLElement) input.focus();
  }, [location.hash]);

  const start = useMutation({
    mutationFn: () => {
      const body: { pr: string; repo?: string } = { pr: pr.trim() };
      const repoPath = repo.trim();
      if (repoPath.length > 0) body.repo = repoPath;
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
      className="flex flex-col gap-3 rounded border border-edge bg-surface px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        start.mutate();
      }}
    >
      <TextInput
        id="review-pr-url"
        label="PR URL"
        value={pr}
        onChange={(event) => setPr(event.target.value)}
        required
        placeholder="https://github.com/org/repo/pull/1"
        autoComplete="off"
      />
      <details>
        <summary className="cursor-pointer select-none text-sm text-muted">高级</summary>
        <div className="mt-2">
          <TextInput
            id="review-repo-path"
            label="本地仓库路径"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="/abs/path/to/checkout"
            autoComplete="off"
            help="可选。对应 CLI --repo；省略时由 CLI 用 repos.json 或 cwd 解析。"
          />
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={start.isPending}>
          {start.isPending ? "正在启动…" : "开始审查"}
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
