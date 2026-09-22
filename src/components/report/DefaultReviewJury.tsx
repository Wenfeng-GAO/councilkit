import { CLAUDE_ROUTE_LABELS } from "@/components/settings/view-model";
import { Select } from "@/components/ui/Select";
import { isAutomaticCursorModel, unavailableCursorSeats } from "@/lib/jury-model-validation";
import { driverLabel, isPersonaSeat, reviewSeatTitle } from "@/lib/seat-label";
import { getAppRuntime } from "@/runtime/bootstrap";
import { RuntimeClientError } from "@/runtime/client";
import { readOrSaveReviewJury } from "@/runtime/review-jury-client";
import type { DriverId } from "@shared/runtime/contracts";
import {
  type ReviewJuryResponse,
  type ReviewJurySeat,
  type ReviewJuryUpdate,
  reviewJuryUpdateSchema,
} from "@shared/runtime/review-jury";
import type { ClaudeRoute, InstallationDto } from "@shared/runtime/schemas";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const KEY = ["cli-review-jury"];
const DRIVERS: { value: DriverId; label: string }[] = [
  { value: "codex-app-server", label: "Codex" },
  { value: "claude-stream-json", label: "Claude" },
  { value: "grok-stream-json", label: "Grok" },
  { value: "kimi-stream-json", label: "Kimi" },
  { value: "cursor-stream-json", label: "Cursor" },
];
function jurySeatHeading(agentName: string, seat: ReviewJurySeat): string {
  return reviewSeatTitle({
    agentName,
    modelId: seat.modelId,
    driverId: seat.driverSelection.driverId,
  });
}

function jurySeatSubheading(agentName: string, seat: ReviewJurySeat): string {
  if (isPersonaSeat(agentName)) return agentName;
  return driverLabel(seat.driverSelection.driverId);
}
export interface JuryStatus {
  ready: boolean;
  summary: string;
}

export function DefaultReviewJury({
  disabled,
  onStatusChange,
}: { disabled: boolean; onStatusChange: (status: JuryStatus) => void }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: () => readOrSaveReviewJury(),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<ReviewJuryUpdate | null>(null);
  const [seatsOpen, setSeatsOpen] = useState(false);
  const { client } = getAppRuntime();
  const installations = useQuery({
    queryKey: ["host", "installations"],
    queryFn: () => client.listInstallations(),
    enabled:
      draft !== null ||
      (query.data?.seats ?? []).some(
        (seat) =>
          seat.driverSelection.driverId === "cursor-stream-json" &&
          !isAutomaticCursorModel(seat.modelId),
      ),
    retry: false,
  });
  const save = useMutation({
    mutationFn: (config: ReviewJuryUpdate) => readOrSaveReviewJury(config),
    onSuccess: (data) => {
      queryClient.setQueryData(KEY, data);
      setDraft(null);
      setSeatsOpen(false);
    },
  });
  const data = query.data;
  const seats = draft?.seats ?? data?.seats ?? [];
  const hasPinnedCursor = seats.some(
    (seat) =>
      seat.driverSelection.driverId === "cursor-stream-json" &&
      !isAutomaticCursorModel(seat.modelId),
  );
  const cursorInstallation = installations.data?.installations.find(
    (item) => item.driverId === "cursor-stream-json" && item.state === "trusted",
  );
  const cursorCatalog = useQuery({
    queryKey: [
      "jury-model-catalog",
      "cursor-stream-json",
      cursorInstallation?.installationId,
      undefined,
    ],
    queryFn: () =>
      client.modelCatalog("cursor-stream-json", cursorInstallation?.installationId ?? ""),
    enabled: hasPinnedCursor && !!cursorInstallation,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const invalidCursor = cursorCatalog.isSuccess
    ? unavailableCursorSeats(seats, cursorCatalog.data.catalog)
    : [];
  const cursorProblem = !hasPinnedCursor
    ? null
    : installations.isPending || (cursorInstallation && cursorCatalog.isPending)
      ? "正在核对 Cursor 实时模型目录…"
      : !cursorInstallation || cursorCatalog.isError
        ? "无法核对 Cursor 模型目录，请刷新后重试。"
        : invalidCursor.length > 0
          ? `Cursor 模型已不可用：${invalidCursor.map((seat) => seat.modelId).join("、")}。请打开「调整席位」，从实时目录重新选择；不会自动更换模型或上下文容量。`
          : null;
  const reporter = draft?.reporterAgentId ?? data?.reporterAgentId;
  const reporterAgent = data?.agents.find((agent) => agent.agentId === reporter);
  const reporterSeat = seats.find((seat) => seat.agentId === reporter);
  const reporterHeading =
    reporterAgent && reporterSeat
      ? jurySeatHeading(reporterAgent.name, reporterSeat)
      : (reporterAgent?.name ?? "待指定");
  const summary =
    query.isFetching && !data
      ? "正在读取默认席位"
      : query.isError
        ? "默认席位读取失败，请重新加载"
        : data
          ? `${seats.length} 个默认席位 · ${reporterHeading}汇总`
          : "正在读取默认席位";
  useEffect(() => {
    onStatusChange({
      ready: !!data && !query.isError && !draft && !save.isPending && !cursorProblem,
      summary: draft ? "请先保存或取消席位调整" : (cursorProblem ?? summary),
    });
  }, [data, draft, query.isError, save.isPending, summary, cursorProblem, onStatusChange]);
  const editSeat = (index: number, next: ReviewJurySeat) =>
    setDraft((current) =>
      current
        ? { ...current, seats: current.seats.map((seat, i) => (i === index ? next : seat)) }
        : current,
    );
  const locked = disabled || save.isPending;
  const showSeats = seatsOpen || draft !== null;

  return (
    <section
      className="ck-default-jury"
      aria-label="默认审查席位"
      data-collapsed={showSeats ? "false" : "true"}
    >
      <div className="ck-roster-heading">
        <div>
          <strong>默认审查席位</strong>
          <span className="ck-jury-count">{data ? `${seats.length} / 8` : "尚未读取"}</span>
        </div>
        {data && !draft ? (
          <div className="ck-jury-heading-actions">
            <button
              type="button"
              className="ck-text-button"
              aria-expanded={showSeats}
              disabled={locked}
              onClick={() => setSeatsOpen((open) => !open)}
            >
              {showSeats ? "收起席位" : "查看席位"}
            </button>
            <button
              type="button"
              className="ck-text-button"
              disabled={locked}
              onClick={() => {
                save.reset();
                setSeatsOpen(true);
                setDraft({
                  revision: data.revision,
                  seats: data.seats,
                  reporterAgentId: data.reporterAgentId,
                });
              }}
            >
              调整席位
            </button>
          </div>
        ) : null}
      </div>
      {cursorProblem ? (
        <output className="ck-jury-error">
          {cursorProblem}
          <button
            type="button"
            className="ck-text-button"
            disabled={locked || installations.isFetching || cursorCatalog.isFetching}
            onClick={() => {
              if (cursorInstallation) void cursorCatalog.refetch();
              else void installations.refetch();
            }}
          >
            刷新目录
          </button>
        </output>
      ) : null}
      {query.isPending ? (
        <output className="ck-model-message">正在读取 pr-jury 默认席位…</output>
      ) : null}
      {query.isError ? (
        <div role="alert" className="ck-jury-error">
          <p>{juryReadError(query.error)}</p>
          <button type="button" className="ck-text-button" onClick={() => void query.refetch()}>
            重新加载
          </button>
        </div>
      ) : null}
      {data && showSeats ? (
        <>
          <ol className="ck-jury-seats">
            {seats.map((seat, index) => {
              const agent = data.agents.find((item) => item.agentId === seat.agentId);
              const name = agent?.name ?? seat.agentId;
              const heading = jurySeatHeading(name, seat);
              return (
                <li key={seat.agentId} className="ck-jury-seat" data-editing={!!draft}>
                  <div className="ck-jury-seat-heading">
                    <span className="ck-jury-number">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <h3>{heading}</h3>
                      <p>{jurySeatSubheading(name, seat)}</p>
                    </div>
                    <div className="ck-jury-seat-actions">
                      {draft ? (
                        <label className="ck-jury-reporter">
                          <input
                            type="radio"
                            name="default-jury-reporter"
                            aria-label={`由${heading}汇总`}
                            checked={reporter === seat.agentId}
                            disabled={locked}
                            onChange={() => setDraft({ ...draft, reporterAgentId: seat.agentId })}
                          />
                          汇总
                        </label>
                      ) : reporter === seat.agentId ? (
                        <span className="ck-jury-badge">Aggregator · 汇总</span>
                      ) : null}
                      {draft ? (
                        <button
                          type="button"
                          className="ck-jury-remove"
                          aria-label={`移除${heading}`}
                          title={
                            reporter === seat.agentId ? "请先指定其他汇总席位" : "从默认班子中移除"
                          }
                          disabled={locked || reporter === seat.agentId || seats.length <= 1}
                          onClick={() =>
                            setDraft({ ...draft, seats: seats.filter((_, i) => i !== index) })
                          }
                        >
                          ×
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {draft ? (
                    <SeatModelFields
                      seat={seat}
                      data={data}
                      installations={installations.data?.installations ?? []}
                      disabled={locked}
                      onChange={(next) => editSeat(index, next)}
                    />
                  ) : (
                    <div className="ck-jury-binding">
                      <span>
                        {
                          DRIVERS.find((driver) => driver.value === seat.driverSelection.driverId)
                            ?.label
                        }
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
          {draft ? (
            <div className="ck-jury-editor-footer">
              <Select
                id="jury-add-seat"
                aria-label="添加席位"
                value=""
                disabled={locked || seats.length >= 8}
                onChange={(event) => {
                  const agent = data.agents.find((item) => item.agentId === event.target.value);
                  if (agent)
                    setDraft({
                      ...draft,
                      seats: [
                        ...seats,
                        {
                          agentId: agent.agentId,
                          modelId: agent.modelId,
                          driverSelection: agent.driverSelection,
                        },
                      ],
                    });
                }}
                options={[
                  { value: "", label: "+ 添加已有 Agent 为席位" },
                  ...data.agents
                    .filter(
                      (agent) =>
                        agent.enabled && !seats.some((seat) => seat.agentId === agent.agentId),
                    )
                    .map((agent) => ({
                      value: agent.agentId,
                      label: reviewSeatTitle({
                        agentName: agent.name,
                        modelId: agent.modelId,
                        driverId: agent.driverSelection.driverId,
                      }),
                    })),
                ]}
              />
              <p>保存后用于之后的 PR 审查。角色职责保持不变，进行中的审查不受影响。</p>
              {save.isError ? (
                <p role="alert" className="ck-jury-error">
                  {save.error.message}
                </p>
              ) : null}
              <div className="ck-jury-save-actions">
                <button
                  type="button"
                  className="ck-text-button"
                  disabled={locked}
                  onClick={() => {
                    setDraft(null);
                    save.reset();
                    void query.refetch();
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="ck-jury-save"
                  disabled={
                    locked || !!cursorProblem || !reviewJuryUpdateSchema.safeParse(draft).success
                  }
                  onClick={() => save.mutate(draft)}
                >
                  {save.isPending ? "正在保存…" : "保存默认席位"}
                </button>
              </div>
            </div>
          ) : (
            <p className="ck-jury-caption">
              {save.isSuccess ? "默认席位已保存。" : "各席位独立审查，由汇总席位对比结论。"}
            </p>
          )}
        </>
      ) : null}
      {data && !draft && !showSeats && save.isSuccess ? (
        <p className="ck-jury-caption">默认席位已保存。</p>
      ) : null}
    </section>
  );
}

function SeatModelFields({
  seat,
  data,
  installations,
  disabled,
  onChange,
}: {
  seat: ReviewJurySeat;
  data: ReviewJuryResponse;
  installations: InstallationDto[];
  disabled: boolean;
  onChange: (seat: ReviewJurySeat) => void;
}) {
  const { client } = getAppRuntime();
  const driverId = seat.driverSelection.driverId;
  const route = driverId === "claude-stream-json" ? seat.driverSelection.options.route : undefined;
  const installation = installations.find(
    (item) => item.driverId === driverId && item.state === "trusted",
  );
  const catalog = useQuery({
    queryKey: ["jury-model-catalog", driverId, installation?.installationId, route],
    queryFn: () => client.modelCatalog(driverId, installation?.installationId ?? "", { route }),
    enabled: !!installation,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const known = data.agents
    .filter(
      (agent) =>
        agent.driverSelection.driverId === driverId &&
        (driverId !== "claude-stream-json" ||
          (agent.driverSelection.driverId === "claude-stream-json" &&
            agent.driverSelection.options.route === route)),
    )
    .map((agent) => agent.modelId);
  const models = [
    ...new Set([
      ...(catalog.data?.catalog ?? []),
      ...(driverId === "codex-app-server" ? data.codexModels : []),
      ...known,
      ...(seat.modelId ? [seat.modelId] : []),
    ]),
  ];
  const id = `jury-${seat.agentId}`;
  return (
    <div className="ck-jury-model-fields">
      <Select
        id={`${id}-driver`}
        label="模型来源"
        value={driverId}
        options={DRIVERS}
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
          ...models.map((value) => ({
            value,
            label:
              driverId === "cursor-stream-json" &&
              catalog.isSuccess &&
              unavailableCursorSeats([{ ...seat, modelId: value }], catalog.data.catalog).length > 0
                ? `${value}（已不在实时目录）`
                : value,
          })),
        ]}
        onChange={(event) => onChange({ ...seat, modelId: event.target.value })}
      />
      <p className="ck-jury-catalog-note">
        {catalog.isError
          ? "实时目录暂不可用，当前显示本机已知模型。"
          : "模型来自本机目录，启动审查时检查可用性。"}
        {installation ? (
          <button
            type="button"
            disabled={disabled || catalog.isFetching}
            onClick={() => void catalog.refetch()}
          >
            刷新
          </button>
        ) : null}
      </p>
    </div>
  );
}

function juryReadError(error: Error): string {
  if (error instanceof RuntimeClientError) {
    if (error.status === 404)
      return "当前 Host 尚未加载默认席位接口，请重启本仓库的 Host 后重新加载。";
    if (error.status === 401 || error.status === 403) return "连接身份已失效，请刷新页面后重试。";
    return error.message;
  }
  return "读取默认席位失败，请检查 Host 连接后重试。";
}
