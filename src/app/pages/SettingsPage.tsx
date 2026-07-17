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
import { Modal } from "@/components/ui/Modal";
import { runtimeDb } from "@/lib/runtime-db";
import { createDiscussionAgent } from "@/models/discussion/factories";
import { type ExecutionProfileRecord, toDto, validateProfileDto } from "@/models/execution-profile";
import { getAppRuntime } from "@/runtime/bootstrap";
import { buildSettingsReadiness } from "@/runtime/readiness";
import { runtimeKeys, useAgents, useExecutionProfiles } from "@/stores/runtime-queries";
import { CREDENTIAL_MODE, type DriverId } from "@shared/runtime/contracts";
import type { ClaudeRoute, ProfileReadiness } from "@shared/runtime/schemas";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

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
      queryFn: () => client.modelCatalog(pair.driverId, pair.installationId, { route: pair.route }),
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
        queryFn: () => client.profileReadiness(toDto(profile), probeModelId),
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

  const readinessModel = buildSettingsReadiness({
    hostOnline,
    installations,
    driverCapabilities: healthQuery.data?.drivers ?? [],
    profiles,
    profileReadiness: profileReadinessMap,
  });

  // --- Repair actions ---
  const revalidateMut = useMutation({
    mutationFn: (installationId: string) => client.revalidateInstallation(installationId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["host", "installations"] }),
  });

  type InfoModal = "restart" | "requirements" | "diagnostics" | null;
  const [infoModal, setInfoModal] = useState<InfoModal>(null);
  const [diagnosticsDriverId, setDiagnosticsDriverId] = useState<DriverId | null>(null);

  // --- Profile CRUD (Dexie; DTO strictly validated on the way in/out) ---
  const refreshRuntimeQueries = () => queryClient.invalidateQueries({ queryKey: runtimeKeys.all });

  const profileOptionsOf = (values: ProfileFormValues) =>
    values.driverId === "claude-stream-json"
      ? { route: values.route }
      : values.reasoningEffort.trim().length > 0
        ? { reasoningEffort: values.reasoningEffort.trim() }
        : {};

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

  const handleUpdateAgent = async (id: string, values: AgentFormValues): Promise<string | null> => {
    const existing = await runtimeDb.agents.get(id);
    if (!existing) return "该 Agent 已不存在。";
    try {
      const validated = createDiscussionAgent(agentFactoryInput(values));
      await runtimeDb.agents.put({
        ...validated,
        id: existing.id,
        revision: existing.revision + 1,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return error instanceof Error ? error.message : "保存 Agent 失败。";
    }
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

  const everythingReady = allSectionsReady(readinessModel);

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-xl font-semibold">设置</h1>
      <p className="mt-1 text-sm text-muted">
        V1 唯一配置入口：自上而下完成四段配置后，即可创建 Agent 与讨论。
      </p>

      <div className="mt-6 flex flex-col gap-8">
        <HostSection
          hostOnline={hostOnline}
          health={healthQuery.data}
          onShowRestartHelp={() => setInfoModal("restart")}
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
