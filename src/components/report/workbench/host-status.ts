import { getAppRuntime } from "@/runtime/bootstrap";
import { useQuery } from "@tanstack/react-query";

export type WorkbenchHostStatus = "checking" | "online" | "offline";

export function hostStatusLabel(status: WorkbenchHostStatus): string {
  if (status === "online") return "Host 在线";
  if (status === "offline") return "Host 离线";
  return "Host 检查中…";
}

/** 与 Sidebar 共用 ["host", "health"] query key，全局导航与状态栏只触发一份健康检查。 */
export function useWorkbenchHostStatus(): WorkbenchHostStatus {
  const { client } = getAppRuntime();
  const query = useQuery({
    queryKey: ["host", "health"],
    queryFn: () => client.health(),
    refetchInterval: 5000,
    retry: false,
  });
  if (query.isPending) return "checking";
  return query.isSuccess ? "online" : "offline";
}
