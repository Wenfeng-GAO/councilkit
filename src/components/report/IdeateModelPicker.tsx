import { CLAUDE_ROUTE_LABELS } from "@/components/settings/view-model";
import { Select } from "@/components/ui/Select";
import {
  IDEATE_DRIVER_OPTIONS,
  ideateDriverLabel,
  ideateRoleLabel,
  rosterToIdeateModels,
  savedRosterUnchanged,
  uniqueModelConfigCount,
} from "@/lib/ideate-roster";
import { getAppRuntime } from "@/runtime/bootstrap";
import { RuntimeClientError } from "@/runtime/client";
import { readProductJury } from "@/runtime/product-jury-client";
import type { DriverId } from "@shared/runtime/contracts";
import type { ReviewJuryResponse, ReviewJurySeat } from "@shared/runtime/review-jury";
import type { ClaudeRoute, IdeateModels, InstallationDto } from "@shared/runtime/schemas";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const KEY = ["cli-product-jury"];

export interface IdeateJuryStatus {
  ready: boolean;
  summary: string;
  models?: IdeateModels;
}

export function IdeateModelPicker({
  disabled,
  onStatusChange,
}: {
  disabled: boolean;
  onStatusChange: (status: IdeateJuryStatus) => void;
}) {
  const query = useQuery({
    queryKey: KEY,
    queryFn: () => readProductJury(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<{
    seats: ReviewJurySeat[];
    reporterAgentId: string;
  } | null>(null);
  const data = query.data;
  const seats = draft?.seats ?? data?.seats ?? [];
  const reporter = draft?.reporterAgentId ?? data?.reporterAgentId;
  const reporterName = data?.agents.find((agent) => agent.agentId === reporter)?.name;
  const enoughSeats = seats.length >= 2 && seats.length <= 8;
  const allBound = seats.every((seat) => seat.modelId.length > 0);
  const override =
    data && draft && !savedRosterUnchanged(data.seats, data.reporterAgentId, draft.seats, draft.reporterAgentId)
      ? rosterToIdeateModels(draft.seats, draft.reporterAgentId)
      : undefined;
  const summary =
    query.isFetching && !data
      ? "正在读取 product-jury"
      : query.isError
        ? "product-jury 读取失败，请重新加载或运行 councilkit init"
        : data && !enoughSeats
          ? `product-jury 只有 ${seats.length} 席，需要 2–8 席才能发起`
          : data
            ? `${seats.length} 个席位 · ${ideateRoleLabel(reporterName ?? "")}汇总${
                uniqueModelConfigCount(seats) === 1 ? " · 单模型多角色" : ""
              }${override ? " · 本次改用其他型号" : ""}`
            : "正在读取 product-jury";
  useEffect(() => {
    onStatusChange({
      ready: !!data && !query.isError && enoughSeats && allBound,
      summary,
      models: override,
    });
  }, [allBound, data, draft, enoughSeats, onStatusChange, override, query.isError, summary]);

  return (
    <section className="ck-default-jury" aria-label="product-jury 席位">
      <div className="ck-roster-heading">
        <div>
          <strong>本机 product-jury</strong>
          <span className="ck-jury-count">{data ? `${seats.length} 席` : "尚未读取"}</span>
        </div>
        {data && !draft ? (
          <button
            type="button"
            className="ck-text-button"
            disabled={disabled}
            onClick={() =>
              setDraft({
                seats: data.seats,
                reporterAgentId: data.reporterAgentId,
              })
            }
          >
            本次改用其他模型
          </button>
        ) : null}
        {draft ? (
          <button
            type="button"
            className="ck-text-button"
            disabled={disabled}
            onClick={() => setDraft(null)}
          >
            使用已保存席位
          </button>
        ) : null}
      </div>
      {query.isPending ? (
        <output className="ck-model-message">正在读取 product-jury…</output>
      ) : null}
      {query.isError ? (
        <div role="alert" className="ck-jury-error">
          <p>{productJuryReadError(query.error)}</p>
          <button type="button" className="ck-text-button" onClick={() => void query.refetch()}>
            重新加载
          </button>
        </div>
      ) : null}
      {data ? (
        <>
          <ol className="ck-jury-seats">
            {seats.map((seat, index) => {
              const agent = data.agents.find((item) => item.agentId === seat.agentId);
              const name = agent?.name ?? seat.agentId;
              return (
                <li key={seat.agentId} className="ck-jury-seat" data-editing={!!draft}>
                  <div className="ck-jury-seat-heading">
                    <span className="ck-jury-number">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <h3>{ideateRoleLabel(name)}</h3>
                      <p>{name}</p>
                    </div>
                    <div className="ck-jury-seat-actions">
                      {draft ? (
                        <label className="ck-jury-reporter">
                          <input
                            type="radio"
                            name="ideate-run-reporter"
                            aria-label={`由${ideateRoleLabel(name)}汇总`}
                            checked={reporter === seat.agentId}
                            disabled={disabled}
                            onChange={() => setDraft({ ...draft, reporterAgentId: seat.agentId })}
                          />
                          汇总
                        </label>
                      ) : reporter === seat.agentId ? (
                        <span className="ck-jury-badge">Reporter · 汇总</span>
                      ) : null}
                    </div>
                  </div>
                  {draft ? (
                    <IdeateSeatModels
                      seat={seat}
                      data={data}
                      disabled={disabled}
                      onChange={(next) =>
                        setDraft({
                          ...draft,
                          seats: draft.seats.map((item, i) => (i === index ? next : item)),
                        })
                      }
                    />
                  ) : (
                    <div className="ck-jury-binding">
                      <span>
                        {ideateDriverLabel(seat.driverSelection.driverId)}
                        {seat.driverSelection.driverId === "claude-stream-json"
                          ? ` · ${seat.driverSelection.options.route}`
                          : ""}
                      </span>
                      <code>{seat.modelId}</code>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <p className="ck-jury-caption">
            {draft
              ? "只影响这一轮。不保存 product-jury；改型号后走一次性 models，角色指令用产品/工程/质疑模板。"
              : "显示本机已保存席位、型号和 Reporter。缺席或定制以这里为准。"}
          </p>
        </>
      ) : null}
    </section>
  );
}

function IdeateSeatModels({
  seat,
  data,
  disabled,
  onChange,
}: {
  seat: ReviewJurySeat;
  data: ReviewJuryResponse;
  disabled: boolean;
  onChange: (seat: ReviewJurySeat) => void;
}) {
  const { client } = getAppRuntime();
  const installations = useQuery({
    queryKey: ["host", "installations"],
    queryFn: () => client.listInstallations(),
    retry: false,
  });
  const driverId = seat.driverSelection.driverId;
  const route = driverId === "claude-stream-json" ? seat.driverSelection.options.route : undefined;
  const installation = (installations.data?.installations ?? []).find(
    (item: InstallationDto) => item.driverId === driverId && item.state === "trusted",
  );
  const catalog = useQuery({
    queryKey: ["ideate-model-catalog", driverId, installation?.installationId, route],
    queryFn: () => client.modelCatalog(driverId, installation?.installationId ?? "", { route }),
    enabled: !!installation,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const known = data.agents
    .filter((agent) => agent.driverSelection.driverId === driverId)
    .map((agent) => agent.modelId);
  const models = [
    ...new Set([
      ...(catalog.data?.catalog ?? []),
      ...(driverId === "codex-app-server" ? data.codexModels : []),
      ...known,
      ...(seat.modelId ? [seat.modelId] : []),
    ]),
  ];
  const id = `ideate-${seat.agentId}`;
  return (
    <div className="ck-jury-model-fields">
      <Select
        id={`${id}-driver`}
        label="模型来源"
        value={driverId}
        options={IDEATE_DRIVER_OPTIONS}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value as DriverId;
          onChange({
            ...seat,
            modelId: "",
            driverSelection:
              next === "claude-stream-json"
                ? { driverId: next, options: { route: "cfuse" } }
                : { driverId: next, options: {} },
          });
        }}
      />
      {driverId === "claude-stream-json" ? (
        <Select
          id={`${id}-route`}
          label="路由"
          value={route}
          disabled={disabled}
          options={Object.entries(CLAUDE_ROUTE_LABELS).map(([value, label]) => ({ value, label }))}
          onChange={(event) =>
            onChange({
              ...seat,
              modelId: "",
              driverSelection: { driverId, options: { route: event.target.value as ClaudeRoute } },
            })
          }
        />
      ) : null}
      <Select
        id={`${id}-model`}
        label="使用模型"
        value={seat.modelId}
        disabled={disabled}
        options={[
          {
            value: "",
            label: catalog.isFetching && models.length === 0 ? "正在读取模型…" : "选择模型",
          },
          ...models.map((value) => ({ value, label: value })),
        ]}
        onChange={(event) => onChange({ ...seat, modelId: event.target.value })}
      />
      <p className="ck-jury-catalog-note">
        {catalog.isError
          ? "实时目录暂不可用，当前显示本机已知模型。"
          : "型号来自本机目录，只用于这一轮。"}
      </p>
    </div>
  );
}

function productJuryReadError(error: Error): string {
  if (error instanceof RuntimeClientError) {
    if (error.status === 404)
      return "当前 Host 尚未加载 product-jury 接口，请重启本仓库的 Host 后重新加载。";
    if (error.status === 401 || error.status === 403) return "连接身份已失效，请刷新页面后重试。";
    return error.message;
  }
  return "读取 product-jury 失败，请检查 Host 连接后重试。";
}
