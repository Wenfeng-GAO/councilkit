# 0008: Two state axes for Room and Round instead of a single room-state model

`docs/product.md` §7.1 defines a single six-state room model (draft/running/paused/concluding/concluded/failed). The V1 runtime cutover proved that scheduling control and execution progress are independent concerns: the user can pause dispatching while a Round is mid-flight, and a Round can pause for repair without touching the Room's scheduling gate. We therefore keep two separate state axes — `Room.runState` (user scheduling gate: idle/running/paused) and `Round.phase` (the round state machine) — and add a third, separate lifecycle flag `Room.status` (open/concluded) for the decision-report lifecycle, instead of adopting product.md's single-axis model.

The report-generation process (concluding) is deliberately NOT a persisted state: it is an orchestration transient. The only persisted lifecycle facts are `open → concluded` on the Room and the committed row in the `reports` table, so crash recovery needs no third lifecycle state and the existing startup-audit classification covers every window.

Consequence: product.md's six-state model is superseded in implementation; UI copy distinguishes 「已暂停调度」(runState) from 「本轮已暂停」(Round.phase) to keep the axes visible to users.
