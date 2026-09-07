import { IdeateModelPicker, type IdeateJuryStatus } from "@/components/report/IdeateModelPicker";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Textarea } from "@/components/ui/Textarea";
import { mapStartIdeateError } from "@/lib/start-review-hints";
import { getAppRuntime } from "@/runtime/bootstrap";
import type { CliRunStartIdeateRequest } from "@shared/runtime/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

export function StartIdeateForm() {
  const { client } = getAppRuntime();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [juryStatus, setJuryStatus] = useState<IdeateJuryStatus>({
    ready: false,
    summary: "正在读取 product-jury",
  });
  const [idea, setIdea] = useState("");
  const [background, setBackground] = useState("");
  const [debateRounds, setDebateRounds] = useState("1");
  const [hint, setHint] = useState<{ text: string; copyCommand: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  const start = useMutation({
    mutationFn: () => {
      const body: CliRunStartIdeateRequest = {
        idea: idea.trim(),
        debateRounds: Number.parseInt(debateRounds, 10) as 0 | 1 | 2,
      };
      const extra = background.trim();
      if (extra.length > 0) body.background = extra;
      if (juryStatus.models) body.models = juryStatus.models;
      return client.startCliIdeate(body);
    },
    onMutate: () => {
      setHint(null);
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ["cli-runs"] });
      navigate(`/reports/${data.runId}`);
    },
    onError: (error) => {
      setHint(mapStartIdeateError(error));
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
      id="ideate"
      className="ck-review-composer"
      aria-labelledby="start-ideate-heading"
      aria-busy={start.isPending}
      onSubmit={(event) => {
        event.preventDefault();
        if (!start.isPending && juryStatus.ready && idea.trim().length > 0) start.mutate();
      }}
    >
      <div className="ck-composer-heading">
        <div>
          <p className="ck-eyebrow">NEW IDEATE</p>
          <h2 id="start-ideate-heading">讨论产品创意</h2>
        </div>
        <span className="ck-composer-note">独立提案 · 串行辩论 · 中立决策</span>
      </div>
      <fieldset disabled={start.isPending} className="ck-composer-fields">
        <Textarea
          id="ideate-idea"
          label="一句话创意"
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          required
          rows={3}
          placeholder="例如：为独立开发者每周整理用户反馈，并给出下周验证任务"
        />
        <Textarea
          id="ideate-background"
          label="背景（可选）"
          value={background}
          onChange={(event) => setBackground(event.target.value)}
          rows={3}
          placeholder="目标用户、时间/预算、明确不做什么"
        />
        <Select
          id="ideate-debate-rounds"
          label="辩论轮次"
          value={debateRounds}
          onChange={(event) => setDebateRounds(event.target.value)}
          options={[
            { value: "0", label: "0 · 只提案，不辩论" },
            { value: "1", label: "1 · 一轮交叉质疑" },
            { value: "2", label: "2 · 两轮交叉质疑" },
          ]}
        />
        <IdeateModelPicker disabled={start.isPending} onStatusChange={setJuryStatus} />
      </fieldset>
      <div className="ck-composer-footer">
        <p>{juryStatus.summary}</p>
        <Button
          className="ck-start-button"
          type="submit"
          disabled={start.isPending || !juryStatus.ready || idea.trim().length === 0}
        >
          {start.isPending ? "正在启动…" : "开始讨论"}
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
