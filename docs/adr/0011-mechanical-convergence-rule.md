# 0011: Mechanical convergence rule — binary last-line vote, no quality scoring

The decision core converges a Room by a fully mechanical rule, not by any quality judgement. The rule, fixed in `discussion-instructions.ts` and the orchestrator state machine:

- the facilitator's Round Summary ends with a binary convergence vote on its last line (`收敛建议：是` / `否`);
- a vote that fails to parse is treated as `否` (parse-failure = no, never an error and never a hidden yes);
- a Room reaches its designed terminal state when `(vote = 是 AND ≥ 1 completed round) OR maxRounds is reached` → the orchestrator transitions `concluding → report → concluded`, committing exactly one Decision Report and persisting a terminal `concluded` state.

## Background: why no quality scoring

A quality-scoring convergence rule (score the synthesized output and conclude above a threshold) was explicitly rejected. Three reasons:

1. **Determinism.** A mechanical rule is reproducible and unit-testable: the same summary last line + round count yields the same verdict, every time. A quality score depends on a second model call (or heuristic) whose output is non-deterministic and would itself need verification, creating an unbounded regression in the gate.
2. **Testability.** The convergence contract is assertable from committed state alone — `reports.length === 1 && room.status === "concluded" && every execution acked && requested === effective` — with no scorer output to stabilize. The smoke tool's `designedConclusion` assertion leans on exactly this.
3. **No judge-trust problem.** A scorer is an authority the rest of the system must trust and that can drift silently. The mechanical rule has no inner judgement to trust: a vote is text on a last line, parsed literally. Disagreement with a real model's judgement is surfaced as a designed conclusion, not adjudicated by a scorer.

## Real consequences (what the soak matrix exposed)

The mechanical rule is correct, but its interaction with real models has real consequences that the S9 soak verification surfaced and that this ADR records so they are not rediscovered:

- **Real models conclude early, frequently.** A real facilitator can vote `是` after any summary where it judges the discussion sufficient (the judgement being itself the property under test). The S9 acceptance JSON records `designedConclusion = true` across the cross-run corpus; this is a designed terminal state, never a defect, and is recorded via the `designedConclusion` field rather than suppressed.
- **Soak upgraded from single-room to cross-room lifecycle.** The old soak contract ("one room runs ≥ 10 rounds AND ≥ 15 min") is probabilistically unreachable once a real facilitator can conclude after any round. The honest soak shape in the S2 era is a cross-room lifecycle: each `ROOM_CONCLUDED` is positively asserted (reports == 1 + room.concluded + ack-clean + requested == effective), the room is closed, and a fresh room continues the soak clock without clearing elapsed time, total rounds, or room count. The exit condition is `totalRoundsCompleted ≥ N AND elapsedMs ≥ T` (both must hold — later-of-the-two).
- **`designedConclusion` is a recording convention.** Because early conclusion is expected and not a defect, it must be recorded explicitly (per-room, and as a top-level row flag) rather than silently swallowed, so acceptance evidence can surface it instead of mistaking it for a stub or a failure.

## Tradeoffs and alternatives (future, non-breaking)

The mechanical rule is a floor, not a ceiling. Alternatives considered and deferred as additive, non-breaking future enhancements:

- **Agenda-aware convergence templates** — seed a real multi-step agenda so "converges on round 1" is factually impossible and the convergence judgement has real input. Already adopted in the smoke rig as test-environment shaping; not a rule change.
- **Minimum-round floor before a vote is honored** — require ≥ K completed rounds before a `是` vote triggers conclusion. Reduces early-conclusion frequency but fights the very judgement property under test; deferred unless real demand appears.
- **Quality scoring as a supplementary signal** — add a scorer output recorded alongside (not replacing) the mechanical verdict. Rejected for V1 per the determinism/testability/trust reasons above; could be added later as a recorded, non-gating signal without breaking the mechanical rule.