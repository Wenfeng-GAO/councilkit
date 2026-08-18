import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextInput";
import type { ExecutionProfileRecord } from "@/models/execution-profile";
import { DRIVER_IDS, type DriverId } from "@shared/runtime/contracts";
import type { ClaudeRoute, InstallationDto } from "@shared/runtime/schemas";
import { useEffect, useState } from "react";
import { CLAUDE_ROUTE_LABELS, driverDisplayName } from "./view-model";

/**
 * Execution Profile create/edit form (U6). Only Driver-typed fields are
 * editable: name, driverId (closed set), installationId (trusted installations
 * of that driver) and the driver's typed options — never executable paths,
 * argv, shell fragments, env or credentials.
 */
export interface ProfileFormValues {
  name: string;
  driverId: DriverId;
  installationId: string;
  /** claude-stream-json typed option (closed route set). */
  route: ClaudeRoute;
  /** codex-app-server typed option (optional free text, max 64). */
  reasoningEffort: string;
}

interface ProfileFormModalProps {
  open: boolean;
  mode: "create" | "edit";
  initial?: ExecutionProfileRecord;
  installations: InstallationDto[];
  onClose: () => void;
  /** Returns an error message to display, or null on success (modal closes). */
  onSubmit: (values: ProfileFormValues) => Promise<string | null>;
}

const DEFAULT_ROUTE: ClaudeRoute = "ant-glm5.2";

export function ProfileFormModal({
  open,
  mode,
  initial,
  installations,
  onClose,
  onSubmit,
}: ProfileFormModalProps) {
  const [name, setName] = useState("");
  const [driverId, setDriverId] = useState<DriverId>("claude-stream-json");
  const [installationId, setInstallationId] = useState("");
  const [route, setRoute] = useState<ClaudeRoute>(DEFAULT_ROUTE);
  const [reasoningEffort, setReasoningEffort] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form every time the modal opens (create: blank; edit: record).
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    const initialDriver = initial?.driverId ?? "claude-stream-json";
    setDriverId(initialDriver);
    setInstallationId(initial?.installationId ?? "");
    setRoute(
      initial?.driverId === "claude-stream-json"
        ? (initial.options as { route: ClaudeRoute }).route
        : DEFAULT_ROUTE,
    );
    setReasoningEffort(
      initial?.driverId === "codex-app-server"
        ? ((initial.options as { reasoningEffort?: string }).reasoningEffort ?? "")
        : "",
    );
    setError(null);
    setSubmitting(false);
  }, [open, initial]);

  const trustedInstallations = installations.filter(
    (item) => item.driverId === driverId && item.state === "trusted",
  );

  const handleDriverChange = (next: DriverId) => {
    setDriverId(next);
    setInstallationId("");
  };

  const handleSubmit = async () => {
    if (submitting) return;
    if (name.trim().length === 0) {
      setError("请填写 Profile 名称。");
      return;
    }
    if (installationId.length === 0) {
      setError("请选择一个已验证可信的 Installation。");
      return;
    }
    setSubmitting(true);
    const failure = await onSubmit({ name, driverId, installationId, route, reasoningEffort });
    setSubmitting(false);
    if (failure) {
      setError(failure);
    } else {
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === "create" ? "新建 Execution Profile" : "编辑 Execution Profile"}
    >
      <div className="flex flex-col gap-3">
        <TextInput
          label="名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：GLM 5.2 主用"
        />
        <Select
          label="Runtime Driver（内置闭集）"
          value={driverId}
          onChange={(event) => handleDriverChange(event.target.value as DriverId)}
          options={DRIVER_IDS.map((id) => ({ value: id, label: driverDisplayName(id) }))}
          disabled={mode === "edit"}
        />
        {trustedInstallations.length === 0 ? (
          <p className="text-xs text-warn">
            该 Driver 暂无已验证可信的 Installation；请先在上一段完成发现与验证。
          </p>
        ) : (
          <Select
            label="Runtime Installation"
            value={installationId}
            onChange={(event) => setInstallationId(event.target.value)}
            options={[
              { value: "", label: "请选择…" },
              ...trustedInstallations.map((item) => ({
                value: item.installationId,
                label: item.installationId,
              })),
            ]}
          />
        )}
        {driverId === "claude-stream-json" ? (
          <Select
            label="Route（claude-stream-json 选项）"
            value={route}
            onChange={(event) => setRoute(event.target.value as ClaudeRoute)}
            options={Object.entries(CLAUDE_ROUTE_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        ) : driverId === "codex-app-server" ? (
          <TextInput
            label="Reasoning effort（codex-app-server 选项，可留空）"
            value={reasoningEffort}
            onChange={(event) => setReasoningEffort(event.target.value)}
            placeholder="例如：medium"
            help="仅保存 Driver 声明的类型化选项；Profile 不保存模型与凭据。"
          />
        ) : (
          <p className="text-xs text-muted">
            {driverId === "grok-stream-json"
              ? "Grok 的模型在 Agent 中从闭集目录（grok-4.6 / grok-4.5）选择；Profile 不保存模型、argv 或凭据，无可编辑选项。"
              : "Kimi 的模型在 Agent 中从闭集目录（kimi-code/k3）选择；Profile 不保存模型、argv 或凭据，无可编辑选项。"}
          </p>
        )}
        {error ? (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || trustedInstallations.length === 0}>
            {submitting ? "保存中…" : mode === "create" ? "创建 Profile" : "保存修改"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
