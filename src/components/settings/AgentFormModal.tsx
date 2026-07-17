import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextInput";
import { Textarea } from "@/components/ui/Textarea";
import type { DiscussionAgent } from "@/models/discussion/entities";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import { getAppRuntime } from "@/runtime/bootstrap";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isValidHexColor, modelCatalogQueryKey } from "./view-model";

/**
 * Agent create/edit form (U6). Agents are created HERE (Settings), not in New
 * Room. The modelId choices come exclusively from the chosen Profile's closed
 * canonical Driver catalog (GET /api/v1/models/catalog) — never free text.
 */
export interface AgentFormValues {
  name: string;
  personaPrompt: string;
  executionProfileId: string;
  modelId: string;
  color: string;
}

interface AgentFormModalProps {
  open: boolean;
  mode: "create" | "edit";
  initial?: DiscussionAgent;
  profiles: ExecutionProfileRecord[];
  hostOnline: boolean;
  onClose: () => void;
  /** Returns an error message to display, or null on success (modal closes). */
  onSubmit: (values: AgentFormValues) => Promise<string | null>;
}

const DEFAULT_COLOR = "#4f6ef7";

export function AgentFormModal({
  open,
  mode,
  initial,
  profiles,
  hostOnline,
  onClose,
  onSubmit,
}: AgentFormModalProps) {
  const { client } = getAppRuntime();
  const [name, setName] = useState("");
  const [personaPrompt, setPersonaPrompt] = useState("");
  const [executionProfileId, setExecutionProfileId] = useState("");
  const [modelId, setModelId] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form every time the modal opens (create: blank; edit: record).
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setPersonaPrompt(initial?.personaPrompt ?? "");
    setExecutionProfileId(initial?.executionProfileId ?? profiles[0]?.id ?? "");
    setModelId(initial?.modelId ?? "");
    setColor(initial?.color ?? DEFAULT_COLOR);
    setError(null);
    setSubmitting(false);
  }, [open, initial, profiles]);

  const chosenProfile = profiles.find((profile) => profile.id === executionProfileId);

  const catalogQuery = useQuery({
    queryKey: chosenProfile
      ? modelCatalogQueryKey(chosenProfile.driverId, chosenProfile.installationId)
      : ["host", "model-catalog", "none"],
    queryFn: () =>
      client.modelCatalog(
        chosenProfile?.driverId as string,
        chosenProfile?.installationId as string,
      ),
    enabled: open && hostOnline && !!chosenProfile,
    staleTime: 60_000,
    retry: false,
  });
  const catalog = catalogQuery.data?.catalog ?? [];

  const handleProfileChange = (nextId: string) => {
    setExecutionProfileId(nextId);
    // The closed catalog belongs to the profile's driver+installation: a
    // model chosen under another profile is not portable.
    setModelId("");
  };

  const handleSubmit = async () => {
    if (submitting) return;
    if (name.trim().length === 0) {
      setError("请填写 Agent 名称。");
      return;
    }
    if (personaPrompt.trim().length === 0) {
      setError("请填写人格设定（personaPrompt）。");
      return;
    }
    if (!chosenProfile) {
      setError("请选择一个 Execution Profile。");
      return;
    }
    if (modelId.trim().length === 0) {
      setError("请从当前 Driver 目录中选择一个 modelId。");
      return;
    }
    if (!isValidHexColor(color)) {
      setError("颜色必须是 #rrggbb 形式的 6 位十六进制值。");
      return;
    }
    setSubmitting(true);
    const failure = await onSubmit({ name, personaPrompt, executionProfileId, modelId, color });
    setSubmitting(false);
    if (failure) {
      setError(failure);
    } else {
      onClose();
    }
  };

  const modelOptions =
    catalog.includes(modelId) || modelId.length === 0 ? catalog : [modelId, ...catalog];

  return (
    <Modal open={open} onClose={onClose} title={mode === "create" ? "新建 Agent" : "编辑 Agent"}>
      <div className="flex flex-col gap-3">
        <TextInput
          label="名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：安全审查员"
        />
        <Textarea
          label="人格设定（personaPrompt）"
          value={personaPrompt}
          onChange={(event) => setPersonaPrompt(event.target.value)}
          rows={4}
          placeholder="描述该 Agent 的角色、立场与发言风格。"
        />
        {profiles.length === 0 ? (
          <p className="text-xs text-warn">
            还没有 Execution Profile；请先在「3. Execution Profiles」段创建一个。
          </p>
        ) : (
          <Select
            label="Execution Profile"
            value={executionProfileId}
            onChange={(event) => handleProfileChange(event.target.value)}
            options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
          />
        )}
        {chosenProfile ? (
          catalogQuery.isLoading ? (
            <p className="text-xs text-muted">正在从 Driver 获取模型目录…</p>
          ) : catalogQuery.isError ? (
            <p role="alert" className="text-xs text-error">
              无法获取模型目录（Installation 或 Driver 不可用）；请先修复上方配置段。
            </p>
          ) : (
            <Select
              label="modelId（Driver 闭集 canonical 目录）"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              options={[
                { value: "", label: "请选择…" },
                ...modelOptions.map((id) => ({
                  value: id,
                  label: catalog.includes(id) ? id : `${id}（不在当前目录）`,
                })),
              ]}
            />
          )
        ) : null}
        <p className="text-xs text-muted">
          选择项为 canonical ID；若 Driver 另行声明 alias，alias 与 canonical ID
          不相等，保存与执行都以 canonical ID 为准。
        </p>
        <div className="flex items-end gap-2">
          <TextInput
            label="颜色（#rrggbb）"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            placeholder="#4f6ef7"
            className="w-32"
          />
          <span
            aria-hidden="true"
            className="mb-1 inline-block h-6 w-6 rounded-full border border-edge"
            style={{ backgroundColor: isValidHexColor(color) ? color : "transparent" }}
          />
        </div>
        {mode === "edit" ? (
          <p className="text-xs text-muted">
            已加入房间的 Participant 保留加入时的配置快照；保存后 revision +1，只影响之后加入房间的
            Participant。
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || profiles.length === 0}>
            {submitting ? "保存中…" : mode === "create" ? "创建 Agent" : "保存修改"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
