import { getAppRuntime } from "@/runtime/bootstrap";
import type { GenerationTimeouts } from "@shared/runtime/generation-timeouts";
import { useQuery } from "@tanstack/react-query";

/** B4 #339: the generation limits the Host enforces (health), so the copy
 * shows the real threshold. Shares RoomHeader's ["host","health"] cache. */
export function useHostGenerationTimeouts(): GenerationTimeouts | null {
  const { data } = useQuery({
    queryKey: ["host", "health"],
    queryFn: () => getAppRuntime().client.health(),
    refetchInterval: 5000,
    retry: false,
  });
  return data?.generationTimeouts ?? null;
}
