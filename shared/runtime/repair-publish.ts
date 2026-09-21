import { z } from "zod";
import { fullSha } from "./repair-identity";

export const publishRecoverySchema = z.enum([
  "record_verified",
  "block_drift",
  "wait_in_flight",
  "publish",
]);
export type PublishRecoveryAction = z.infer<typeof publishRecoverySchema>;

export interface PublishRecovery {
  action: PublishRecoveryAction;
  sha: string | null;
  reason: string;
}

/**
 * Receipt lost is recoverable by reading the remote. Drift does not overwrite.
 * In-flight work is not republished. Does not claim the network request ran once.
 */
export function recoverPublishReceipt(input: {
  intendedSha: string;
  receiptSha: string | null | "unknown";
  remoteHead: string | null | "unknown";
  inFlight: boolean;
}): PublishRecovery {
  const intended = fullSha(input.intendedSha);
  if (!intended) {
    return { action: "block_drift", sha: null, reason: "intended candidate SHA unknown" };
  }
  const remote = input.remoteHead === "unknown" ? null : fullSha(input.remoteHead);
  const receipt =
    input.receiptSha === "unknown" || input.receiptSha === null ? null : fullSha(input.receiptSha);

  if (remote === intended) {
    return {
      action: "record_verified",
      sha: intended,
      reason: receipt === intended ? "receipt and remote match" : "remote already is the candidate",
    };
  }
  if (remote && remote !== intended) {
    return { action: "block_drift", sha: remote, reason: "remote drifted from intended candidate" };
  }
  if (input.inFlight) {
    return { action: "wait_in_flight", sha: intended, reason: "publish may still be in flight" };
  }
  if (receipt === intended && !remote) {
    return { action: "wait_in_flight", sha: intended, reason: "receipt present but remote unread" };
  }
  return { action: "publish", sha: intended, reason: "no verified remote candidate yet" };
}
