import type { AgentFormValues } from "@/components/settings/AgentFormModal";
import { AgentsSection } from "@/components/settings/AgentsSection";
import { HostSection } from "@/components/settings/HostSection";
import { InstallationsSection } from "@/components/settings/InstallationsSection";
import type { ProfileFormValues } from "@/components/settings/ProfileFormModal";
import { ProfilesSection } from "@/components/settings/ProfilesSection";
import {
  allSectionsReady,
  modelCatalogQueryKey,
  profileRouteOf,
} from "@/components/settings/view-model";
import { StatusPill } from "@/components/shared/StatusPill";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { importAgents } from "@/lib/agent-io";
import { type CouncilKitRuntimeDB, runtimeDb } from "@/lib/runtime-db";
import type { DiscussionAgent } from "@/models/discussion/entities";
import { TransactionError, createDiscussionAgent } from "@/models/discussion/factories";
import { type ExecutionProfileRecord, toDto, validateProfileDto } from "@/models/execution-profile";
import { getAppRuntime } from "@/runtime/bootstrap";
import { buildSettingsReadiness } from "@/runtime/readiness";
import { runtimeKeys, useAgents, useExecutionProfiles } from "@/stores/runtime-queries";
import { CREDENTIAL_MODE, type DriverId } from "@shared/runtime/contracts";
import type { ClaudeRoute, ProfileReadiness } from "@shared/runtime/schemas";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";

/**
 * S7（S1 登记雷修复）：Agent 编辑合并。`createDiscussionAgent` 工厂恒产
 * `enabled: true`，直接 spread 后 put 会把存量的 `enabled: false` 静默重置——
 * 这里显式保留既有 id/enabled/createdAt，revision 照旧 +1。工厂校验
 * （INVALID on bad name/color…）原样生效。纯函数导出供单测
 * （parseMaxRoundsInput 先例）。
 */
export function mergeAgentEdit(
  existing: DiscussionAgent,
  values: AgentFormValues,
): DiscussionAgent {
  const validated = createDiscussionAgent({
    name: values.name.trim(),
    personaPrompt: values.personaPrompt,
    executionProfileId: values.executionProfileId,
    modelId: values.modelId,
    color: values.color,
  });
  return {
    ...validated,
    id: existing.id,
    enabled: existing.enabled,
    revision: existing.revision + 1,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * S7 R3：启停原子读改写。`Table.update` 只写指定字段（无整行回写），并发
 * 启停/编辑不再静默互相覆盖（S1 类覆盖的修复）。返回是否命中（false 即
 * Agent 已不存在）。导出供单测（mergeAgentEdit 先例）。
 */
export async function setAgentEnabled(
  db: CouncilKitRuntimeDB,
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const changed = await db.agents.update(id, { enabled, updatedAt: new Date().toISOString() });
  return changed > 0;
}

/**
 * S7 R3：编辑乐观锁。事务内重读 fresh 行，revision 与「进入时」不一致则抛
 * CONCURRENT_MODIFICATION（可解释的编辑冲突）；否则基于 fresh 行合并 put，
 * 合并在同一事务内提交，窗口被压进单事务。导出供单测（mergeAgentEdit 先例）。
 */
export async function updateAgentWithRevisionCheck(
  db: CouncilKitRuntimeDB,
  id: string,
  enteredRevision: number,
  values: AgentFormValues,
): Promise<void> {
  await db.transaction("rw", [db.agents], async () => {
    const fresh = await db.agents.get(id);
    if (!fresh) throw new TransactionError("AGENT_NOT_FOUND", `unknown agent ${id}`);
    if (fresh.revision !== enteredRevision) {
      throw new TransactionError(
        "CONCURRENT_MODIFICATION",
        "该 Agent 在编辑期间被其他页面修改，请刷新后重试。",
      );
    }
    await db.agents.put(mergeAgentEdit(fresh, values));
  });
}

/**
 * S7 fix-2 #3：编辑提交链（handleUpdateAgent 的纯函数核，导出供单测——
 * mergeAgentEdit 先例）。期望值 enteredRevision 由调用方在「打开编辑框时」
 * 捕获（AgentsSection 的 editing 状态持有打开时刻的行）；绝不提交时重读现值
 * 当期望——并发另一方保存后，重读到的是对方的新 revision，乐观锁失效仍覆盖。
 * AGENT_NOT_FOUND 映射为与「进入时缺失」相同的提示文案。
 */
export async function submitAgentEdit(
  db: CouncilKitRuntimeDB,
  id: string,
  enteredRevision: number,
  values: AgentFormValues,
): Promise<string | null> {
  try {
    await updateAgentWithRevisionCheck(db, id, enteredRevision, values);
  } catch (error) {
    if (error instanceof TransactionError && error.code === "AGENT_NOT_FOUND") {
      return "该 Agent 已不存在。";
    }
    return error instanceof Error ? error.message : "保存 Agent 失败。";
  }
  return null;
}

/**
 * Settings (U6): the ONLY configuration entry of V1 — four top-down sections
 * (Host → Installations/登录能力 → Execution Profiles → Agents). No API
 * Key/Gateway UI exists here. Dynamic readiness uses the same Driver handshake
 * as execution (profile readiness probe + closed model catalog); every row
 * carries the plan Readiness table's exact state vocabulary and its single
 * repair action.
 */
export function SettingsPage() {
  const { client } = getAppRuntime();
  const queryClient = useQueryClient();

  // S8 hash-scroll（裁决 #1）：React Router 客户端导航不滚 hash（RoomPage #report
  // 手写 effect 先例）。paused 面板的「直达链接」指向 #settings-installations /
  // #settings-agents，此处效果等价把对应 section 滚入视口。reduced-motion 下
  // 用 "auto"（globals.css 媒体查询管不到 JS 动画）。
  const settingsLocation = useLocation();
  useEffect(() => {
    if (!settingsLocation.hash) return;
    const node = document.getElementById(settingsLocation.hash.slice(1));
    if (!node) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  }, [settingsLocation.hash]);

  // S5 (R2): a manual "重新检查" forces refresh=1 (bypass the Host probe cache
  // + failure backoff) for both readiness and catalog. The button is disabled
  // while a recheck is in flight (recheckInFlight) so a second click cannot
  // stack a second wave of forced handshakes.
  const [recheckInFlight, setRecheckInFlight] = useState(false);

  // S6: diagnostics export in flight (button disabled while the Host
  // assembles the bundle and the download is triggered).
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);

  // --- Host health (polled; the page blocks new execution when it drops) ---
  const healthQuery = useQuery({
    queryKey: ["host", "health"],
    queryFn: () => client.health(),
    refetchInterval: 5000,
    retry: false,
  });
  const hostOnline: boolean | null = healthQuery.isPending ? null : healthQuery.isSuccess;

  // --- Installations (polled while the Host is reachable) ---
  const installationsQuery = useQuery({
    queryKey: ["host", "installations"],
    queryFn: () => client.listInstallations(),
    enabled: hostOnline === true,
    refetchInterval: 5000,
    retry: false,
  });
  const installations = useMemo(
    () => installationsQuery.data?.installations ?? [],
    [installationsQuery.data],
  );

  // --- Local config entities (Dexie) ---
  const profilesQuery = useExecutionProfiles();
  const profiles = useMemo(() => profilesQuery.data ?? [], [profilesQuery.data]);
  const agentsQuery = useAgents();
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);

  // --- Closed model catalogs: one query per unique driver+installation+route
  // (the claude catalog is route-specific) ---
  const catalogPairs = useMemo(() => {
    const seen = new Set<string>();
    const pairs: { driverId: DriverId; installationId: string; route?: ClaudeRoute }[] = [];
    for (const profile of profiles) {
      const route = profileRouteOf(profile);
      const key = `${profile.driverId}::${profile.installationId}::${route ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ driverId: profile.driverId, installationId: profile.installationId, route });
      }
    }
    return pairs;
  }, [profiles]);

  const catalogQueries = useQueries({
    queries: catalogPairs.map((pair) => ({
      queryKey: modelCatalogQueryKey(pair.driverId, pair.installationId, pair.route),
      queryFn: () =>
        // S5 (R2): the catalog queryFn never forces refresh — it reads the Host
        // probe cache. The manual "重新检查" button bypasses the cache by calling
        // the client directly with refresh:true and setQueryData (see
        // handleRecheckAll), so invalidate-then-refetch cannot be downgraded by a
        // same-key observer whose queryFn ignores the refresh flag.
        client.modelCatalog(pair.driverId, pair.installationId, {
          route: pair.route,
        }),
      enabled: hostOnline === true,
      staleTime: 60_000,
      retry: false,
    })),
  });

  const probeModelIdFor = (profile: ExecutionProfileRecord): string => {
    const index = catalogPairs.findIndex(
      (pair) =>
        pair.driverId === profile.driverId &&
        pair.installationId === profile.installationId &&
        pair.route === profileRouteOf(profile),
    );
    const firstCatalogEntry =
      index >= 0
        ? catalogQueries[index]?.data?.catalog.find((id) => id.trim().length > 0)
        : undefined;
    if (firstCatalogEntry) return firstCatalogEntry;
    // Catalog unavailable/empty: still run the readiness handshake with any
    // agent's modelId so installation/driver failures surface accurately.
    return (
      agents.find((agent) => agent.executionProfileId === profile.id)?.modelId ??
      agents[0]?.modelId ??
      "__unknown__"
    );
  };

  // --- Dynamic profile readiness: same Driver handshake as execution ---
  const readinessQueries = useQueries({
    queries: profiles.map((profile) => {
      const probeModelId = probeModelIdFor(profile);
      return {
        queryKey: ["host", "profile-readiness", profile.id, profile.revision, probeModelId],
        queryFn: () =>
          // S5 (R2): same as catalog — the queryFn never forces refresh; the
          // "重新检查" button calls the client directly with refresh:true and
          // setQueryData so the forced handshake is never downgraded by a
          // same-key observer (AgentFormModal registers one for catalog).
          client.profileReadiness(toDto(profile), probeModelId),
        enabled: hostOnline === true,
        staleTime: 30_000,
        retry: false,
      };
    }),
  });

  const profileReadinessMap = useMemo(() => {
    const map: Record<string, ProfileReadiness | undefined> = {};
    profiles.forEach((profile, index) => {
      map[profile.id] = readinessQueries[index]?.data?.readiness;
    });
    return map;
  }, [profiles, readinessQueries]);

  // S5: per-profile probe metadata (cachedAt -> "X 秒前"; retryAfterMs on
  // failure-backoff) projected into the readiness row model.
  const profileProbeMeta = useMemo(() => {
    const map: Record<string, { cachedAt?: string; retryAfterMs?: number } | undefined> = {};
    profiles.forEach((profile, index) => {
      const data = readinessQueries[index]?.data;
      if (!data) return;
      const meta: { cachedAt?: string; retryAfterMs?: number } = {};
      if (data.cachedAt) meta.cachedAt = data.cachedAt;
      if (data.retryAfterMs !== undefined) meta.retryAfterMs = data.retryAfterMs;
      map[profile.id] = Object.keys(meta).length > 0 ? meta : undefined;
    });
    return map;
  }, [profiles, readinessQueries]);

  const readinessModel = buildSettingsReadiness({
    hostOnline,
    installations,
    driverCapabilities: healthQuery.data?.drivers ?? [],
    profiles,
    profileReadiness: profileReadinessMap,
    profileProbeMeta,
  });

  // S5 (R2): the manual "重新检查" forces a true refresh=1 handshake for every
  // profile readiness and every catalog pair, bypassing the Host probe cache +
  // failure backoff. It calls the client DIRECTLY with { refresh: true } and
  // writes each result into its exact query key via setQueryData — NOT ref +
  // invalidate. The previous ref+invalidate scheme relied on the shared queryFn
  // reading the ref, but AgentFormModal registers a same-key catalog observer
  // (enabled:false until opened) whose own queryFn ignores the ref, so a
  // refetch could be served by that observer's queryFn and drop refresh=1
  // (TanStack Query 5.101.0 behavior). Direct call + setQueryData makes refresh
  // deterministic regardless of which queryFn owns the key. A non-ready 200 body
  // (readiness state !== "ready") is a successful HTTP response and is written
  // back too, so the rendered row matches the fresh handshake; transport errors
  // (4xx/5xx) leave the cached value intact rather than blanking the row.
  const handleRecheckAll = async () => {
    setRecheckInFlight(true);
    try {
      const readinessCalls = profiles.map(async (profile) => {
        const probeModelId = probeModelIdFor(profile);
        try {
          const data = await client.profileReadiness(toDto(profile), probeModelId, {
            refresh: true,
          });
          queryClient.setQueryData(
            ["host", "profile-readiness", profile.id, profile.revision, probeModelId],
            data,
          );
        } catch {
          // Transport/4xx/5xx: leave the cached readiness intact.
        }
      });
      const catalogCalls = catalogPairs.map(async (pair) => {
        try {
          const data = await client.modelCatalog(pair.driverId, pair.installationId, {
            route: pair.route,
            refresh: true,
          });
          queryClient.setQueryData(
            modelCatalogQueryKey(pair.driverId, pair.installationId, pair.route),
            data,
          );
        } catch {
          // Transport/4xx/5xx: leave the cached catalog intact.
        }
      });
      await Promise.all([...readinessCalls, ...catalogCalls]);
    } finally {
      setRecheckInFlight(false);
    }
  };

  // S5: the global "重新检查" button is disabled while the Host is down, while
  // a recheck is in flight (recheckInFlight), or while any readiness/catalog
  // query is fetching (per ruling #2: a recheck in flight is the only thing
  // that blocks the recheck; Profile/Agent form submits are never gated).
  const anyProbeFetching =
    readinessQueries.some((query) => query.isFetching) ||
    catalogQueries.some((query) => query.isFetching);
  const rechecking = recheckInFlight || anyProbeFetching;

  // S6: diagnostics export — the Host assembles a sanitized same-machine
  // bundle; the page only serializes the validated DTO into a single-file
  // download (the ReportView Blob pattern, zero new dependencies). Failures
  // are silent by design, like the recheck calls above: the button re-enables
  // and the 5s health poll surfaces Host trouble.
  const handleExportDiagnostics = async () => {
    setExportingDiagnostics(true);
    try {
      const data = await client.diagnostics();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `councilkit-diagnostics-${data.generatedAt.replace(/[:.]/g, "-")}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      // Host read failure: no partial file is produced; the button re-enables.
    } finally {
      setExportingDiagnostics(false);
    }
  };

  // --- Repair actions ---
  const revalidateMut = useMutation({
    mutationFn: (installationId: string) => client.revalidateInstallation(installationId),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["host", "installations"] });
      // S5: the Host route already invalidated the probe cache; refetch the
      // readiness + catalog so the page immediately shows fresh handshakes.
      queryClient.invalidateQueries({ queryKey: ["host", "profile-readiness"] });
      queryClient.invalidateQueries({ queryKey: ["host", "model-catalog"] });
    },
  });

  type InfoModal = "restart" | "requirements" | "diagnostics" | null;
  const [infoModal, setInfoModal] = useState<InfoModal>(null);
  const [diagnosticsDriverId, setDiagnosticsDriverId] = useState<DriverId | null>(null);

  // --- Profile CRUD (Dexie; DTO strictly validated on the way in/out) ---
  const refreshRuntimeQueries = () => queryClient.invalidateQueries({ queryKey: runtimeKeys.all });

  const profileOptionsOf = (values: ProfileFormValues) => {
    if (values.driverId === "claude-stream-json") return { route: values.route };
    if (values.driverId === "codex-app-server") {
      return values.reasoningEffort.trim().length > 0
        ? { reasoningEffort: values.reasoningEffort.trim() }
        : {};
    }
    // kimi-stream-json / grok-stream-json: no model/argv/token Profile options.
    return {};
  };

  const handleCreateProfile = async (values: ProfileFormValues): Promise<string | null> => {
    const validation = validateProfileDto({
      driverId: values.driverId,
      installationId: values.installationId,
      credentialMode: CREDENTIAL_MODE,
      options: profileOptionsOf(values),
    });
    if (!validation.ok) return "Profile 校验失败：字段不符合 Driver 的类型化选项要求。";
    const ts = new Date().toISOString();
    const record: ExecutionProfileRecord = {
      id: crypto.randomUUID(),
      name: values.name.trim(),
      driverId: validation.dto.driverId,
      installationId: validation.dto.installationId,
      credentialMode: validation.dto.credentialMode,
      options: validation.dto.options,
      revision: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    await runtimeDb.executionProfiles.add(record);
    await refreshRuntimeQueries();
    return null;
  };

  const handleUpdateProfile = async (
    id: string,
    values: ProfileFormValues,
  ): Promise<string | null> => {
    const existing = await runtimeDb.executionProfiles.get(id);
    if (!existing) return "该 Profile 已不存在。";
    const validation = validateProfileDto({
      driverId: values.driverId,
      installationId: values.installationId,
      credentialMode: CREDENTIAL_MODE,
      options: profileOptionsOf(values),
    });
    if (!validation.ok) return "Profile 校验失败：字段不符合 Driver 的类型化选项要求。";
    await runtimeDb.executionProfiles.put({
      ...existing,
      name: values.name.trim(),
      installationId: validation.dto.installationId,
      options: validation.dto.options,
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    await refreshRuntimeQueries();
    return null;
  };

  const handleDeleteProfile = async (id: string): Promise<string | null> => {
    const referencing = await runtimeDb.agents.where("executionProfileId").equals(id).count();
    if (referencing > 0) {
      return `有 ${referencing} 个 Agent 正在引用该 Profile。请先在下方「4. Agents」段修改这些 Agent 的绑定或删除它们。`;
    }
    await runtimeDb.executionProfiles.delete(id);
    await refreshRuntimeQueries();
    return null;
  };

  // --- Agent CRUD (factory semantics; edits bump revision + updatedAt) ---
  const agentFactoryInput = (values: AgentFormValues) => ({
    name: values.name.trim(),
    personaPrompt: values.personaPrompt,
    executionProfileId: values.executionProfileId,
    modelId: values.modelId,
    color: values.color,
  });

  const handleCreateAgent = async (values: AgentFormValues): Promise<string | null> => {
    try {
      await runtimeDb.agents.add(createDiscussionAgent(agentFactoryInput(values)));
    } catch (error) {
      return error instanceof Error ? error.message : "创建 Agent 失败。";
    }
    await refreshRuntimeQueries();
    return null;
  };

  // S7 fix-2 #3：enteredRevision 来自 AgentsSection 打开编辑框时捕获的行，
  // 不再提交时重读现值当期望（并发另一方保存后重读到的是对方的新 revision，
  // 乐观锁会形同虚设）。
  const handleUpdateAgent = async (
    id: string,
    enteredRevision: number,
    values: AgentFormValues,
  ): Promise<string | null> => {
    const failure = await submitAgentEdit(runtimeDb, id, enteredRevision, values);
    if (failure !== null) return failure;
    await refreshRuntimeQueries();
    return null;
  };

  const handleDeleteAgent = async (id: string): Promise<string | null> => {
    const referencing = await runtimeDb.participants.where("agentId").equals(id).count();
    if (referencing > 0) {
      return `该 Agent 已作为 Participant 加入 ${referencing} 个房间参与关系；删除会破坏既有讨论记录。如不再使用，请编辑为新配置（已加入房间的 Participant 会保留加入时快照）。`;
    }
    await runtimeDb.agents.delete(id);
    await refreshRuntimeQueries();
    return null;
  };

  // --- S7 Agent 资产化（启停 / 复制 / 导入；导出与测试调用在 AgentsSection 自接线） ---

  const handleToggleAgentEnabled = async (id: string, enabled: boolean): Promise<string | null> => {
    if (!(await setAgentEnabled(runtimeDb, id, enabled))) return "该 Agent 已不存在。";
    await refreshRuntimeQueries();
    return null;
  };

  const handleDuplicateAgent = async (id: string): Promise<string | null> => {
    const existing = await runtimeDb.agents.get(id);
    if (!existing) return "该 Agent 已不存在。";
    try {
      await runtimeDb.agents.add(
        createDiscussionAgent({
          name: `${existing.name}（副本）`,
          personaPrompt: existing.personaPrompt,
          executionProfileId: existing.executionProfileId,
          modelId: existing.modelId,
          color: existing.color,
        }),
      );
    } catch (error) {
      return error instanceof Error ? error.message : "复制 Agent 失败。";
    }
    await refreshRuntimeQueries();
    return null;
  };

  const handleImportAgents = async (file: File): Promise<string> => {
    let json: string;
    try {
      json = await file.text();
    } catch {
      return "导入失败：无法读取文件。";
    }
    const result = await importAgents(runtimeDb, json);
    if (!result.ok) return `导入失败：${result.error}`;
    await refreshRuntimeQueries();
    const unboundNote =
      result.unbound.length > 0
        ? `；其中 ${result.unbound.length} 个待绑定 Profile（编辑重新绑定后可用）：${result.unbound
            .map((agent) => agent.name)
            .join("、")}`
        : "";
    return `已导入 ${result.imported.length} 个 Agent${unboundNote}。`;
  };

  const everythingReady = allSectionsReady(readinessModel);

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">设置</h1>
          <p className="mt-1 text-sm text-muted">
            V1 唯一配置入口：自上而下完成四段配置后，即可创建 Agent 与讨论。
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="ghost"
            onClick={handleRecheckAll}
            disabled={hostOnline !== true || rechecking}
          >
            {rechecking ? "正在重新检查…" : "重新检查"}
          </Button>
          <p className="text-xs text-muted">强制重新握手（refresh=1），绕过 60 秒缓存与失败退避</p>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-8">
        <HostSection
          hostOnline={hostOnline}
          health={healthQuery.data}
          onShowRestartHelp={() => setInfoModal("restart")}
          onExportDiagnostics={() => void handleExportDiagnostics()}
          exporting={exportingDiagnostics}
        />

        <InstallationsSection
          hostOnline={hostOnline === true}
          installations={readinessModel.installations}
          drivers={readinessModel.drivers}
          isLoading={installationsQuery.isPending}
          revalidatingId={revalidateMut.isPending ? (revalidateMut.variables ?? null) : null}
          driversRechecking={healthQuery.isRefetching}
          onRevalidate={(id) => revalidateMut.mutate(id)}
          onShowRequirements={() => setInfoModal("requirements")}
          onRecheckDrivers={() => void healthQuery.refetch()}
          onShowDiagnostics={(driverId) => {
            setDiagnosticsDriverId(driverId);
            setInfoModal("diagnostics");
          }}
        />

        <ProfilesSection
          hostOnline={hostOnline === true}
          profiles={profiles}
          items={readinessModel.profiles}
          installations={installations}
          onCreate={handleCreateProfile}
          onUpdate={handleUpdateProfile}
          onDelete={handleDeleteProfile}
        />

        <div id="agents">
          <AgentsSection
            hostOnline={hostOnline === true}
            agents={agents}
            profiles={profiles}
            onCreate={handleCreateAgent}
            onUpdate={handleUpdateAgent}
            onDelete={handleDeleteAgent}
            onToggleEnabled={handleToggleAgentEnabled}
            onDuplicate={handleDuplicateAgent}
            onImport={handleImportAgents}
          />
        </div>

        {everythingReady ? (
          <div className="flex flex-col gap-2 rounded border border-success bg-surface px-3 py-3">
            <StatusPill
              tone="success"
              text="全部就绪：可以创建 Agent/Room"
              className="self-start"
            />
            <div>
              <Link to="/rooms/new" className="text-sm text-accent hover:underline">
                继续下一配置段：新建讨论 →
              </Link>
            </div>
          </div>
        ) : null}
      </div>

      <Modal
        open={infoModal === "restart"}
        onClose={() => setInfoModal(null)}
        title="重启本地执行服务"
      >
        <div className="flex flex-col gap-2 text-sm text-fg">
          <p>Runtime Host 是一个前台本机进程，固定在 127.0.0.1:43127 提供服务：</p>
          <ol className="list-decimal pl-5">
            <li>在启动它的终端按 Ctrl+C 停止旧进程（若仍在运行）。</li>
            <li>开发模式运行 `pnpm dev`；或先 `pnpm build` 后以 `pnpm start` 运行生产模式。</li>
            <li>若提示端口被占用，先找到并停止占用 43127 的进程； canonical origin 不会更换。</li>
          </ol>
          <p className="text-xs text-muted">重启后回到本页，健康检查每 5 秒自动恢复。</p>
        </div>
      </Modal>

      <Modal
        open={infoModal === "requirements"}
        onClose={() => setInfoModal(null)}
        title="安装/路径要求"
      >
        <div className="flex flex-col gap-2 text-sm text-fg">
          <p>Runtime Installation 只能由 Host 在本机发现并经校验后信任：</p>
          <ol className="list-decimal pl-5">
            <li>在本机安装对应 CLI（cld 或 Codex），保持默认安装路径。</li>
            <li>Host 会校验真实路径与文件指纹；symlink 替换或路径异常会标记为 invalid。</li>
            <li>程序被升级或替换后状态变为 changed，使用「重新验证」确认新版本。</li>
          </ol>
          <p className="text-xs text-muted">
            导入的配置永远不会让某个程序自动获得信任；信任只能来自本机发现与验证。
          </p>
        </div>
      </Modal>

      <Modal
        open={infoModal === "diagnostics"}
        onClose={() => setInfoModal(null)}
        title="诊断 / 更新 CLI"
      >
        <div className="flex flex-col gap-2 text-sm text-fg">
          <p>
            Driver「{diagnosticsDriverId ?? ""}」缺少必需的协议能力（incompatible），通常是本机 CLI
            版本过旧：
          </p>
          <ol className="list-decimal pl-5">
            <li>查看启动 Host 的终端输出的结构化诊断日志（含 diagnosticId）。</li>
            <li>按该 CLI 的官方指引升级到最新版本。</li>
            <li>升级后回到本页，状态会在下一次健康检查（约 5 秒）自动更新。</li>
          </ol>
        </div>
      </Modal>
    </div>
  );
}
