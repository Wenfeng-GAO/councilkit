import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextInput";
import type { Gateway, GatewayType } from "@/models";
import { useEffect, useState } from "react";

export interface GatewayFormValues {
  name: string;
  type: GatewayType;
  baseUrl: string;
  defaultModel: string;
  apiKey?: string;
}

interface GatewayFormModalProps {
  open: boolean;
  mode: "create" | "edit";
  initial?: Gateway;
  onClose: () => void;
  onSubmit: (vals: GatewayFormValues) => void;
}

const TYPE_OPTIONS = [
  { value: "anthropic", label: "Anthropic (/v1/messages)" },
  {
    value: "openai-compatible",
    label: "OpenAI 兼容 (/v1/chat/completions，含 OpenAI/DeepSeek/Ollama/vLLM)",
  },
];

const EMPTY_VALUES: GatewayFormValues = {
  name: "",
  type: "anthropic",
  baseUrl: "",
  defaultModel: "",
  apiKey: "",
};

export function GatewayFormModal({
  open,
  mode,
  initial,
  onClose,
  onSubmit,
}: GatewayFormModalProps) {
  const [values, setValues] = useState<GatewayFormValues>(EMPTY_VALUES);
  const [error, setError] = useState<string | null>(null);

  // open / mode 切换时重置表单。编辑态预填 initial；apiKey 留空占位。
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === "edit" && initial) {
      setValues({
        name: initial.name,
        type: initial.type,
        baseUrl: initial.baseUrl,
        defaultModel: initial.defaultModel,
        apiKey: "",
      });
    } else {
      setValues(EMPTY_VALUES);
    }
  }, [open, mode, initial]);

  const submit = () => {
    const trimmedName = values.name.trim();
    const trimmedBaseUrl = values.baseUrl.trim();
    const trimmedModel = values.defaultModel.trim();
    const trimmedKey = values.apiKey?.trim() ?? "";

    const nameOk = trimmedName.length > 0;
    const typeOk = values.type === "anthropic" || values.type === "openai-compatible";
    const baseUrlOk = trimmedBaseUrl.length > 0;
    const modelOk = trimmedModel.length > 0;
    const apiKeyOk = mode === "edit" ? true : trimmedKey.length > 0;

    if (!(nameOk && typeOk && baseUrlOk && modelOk && apiKeyOk)) {
      setError("请填写名称、类型、base URL 与 API 密钥。");
      return;
    }
    setError(null);
    onSubmit({
      name: trimmedName,
      type: values.type,
      baseUrl: trimmedBaseUrl,
      defaultModel: trimmedModel,
      apiKey: trimmedKey.length > 0 ? trimmedKey : undefined,
    });
  };

  const apiKeyPlaceholder = mode === "edit" ? "••••••••" : "sk-…";

  return (
    <Modal open={open} onClose={onClose} title={mode === "create" ? "添加网关" : "编辑网关"}>
      <div className="flex flex-col gap-4">
        <TextInput
          label="名称"
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          placeholder="例: Claude 主账号"
          help="仅本机显示。"
        />
        <Select
          label="类型"
          options={TYPE_OPTIONS}
          value={values.type}
          onChange={(e) => setValues((v) => ({ ...v, type: e.target.value as GatewayType }))}
        />
        <TextInput
          label="Base URL"
          value={values.baseUrl}
          onChange={(e) => setValues((v) => ({ ...v, baseUrl: e.target.value }))}
          placeholder="例: https://api.anthropic.com"
          help="只填 host。代码按类型自动拼 /v1/messages 或 /v1/chat/completions。"
        />
        <TextInput
          label="API 密钥"
          type="password"
          value={values.apiKey ?? ""}
          onChange={(e) => setValues((v) => ({ ...v, apiKey: e.target.value }))}
          placeholder={apiKeyPlaceholder}
          help="AES 加密后存于 localStorage，不会离开本机浏览器。"
        />
        <TextInput
          label="默认模型 ID"
          value={values.defaultModel}
          onChange={(e) => setValues((v) => ({ ...v, defaultModel: e.target.value }))}
          placeholder="例: claude-sonnet-4"
          help="新建 agent 时据此预填。可在 agent 编辑中覆盖。"
        />
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button className="h-10" onClick={submit}>
            保存网关
          </Button>
        </div>
      </div>
    </Modal>
  );
}
