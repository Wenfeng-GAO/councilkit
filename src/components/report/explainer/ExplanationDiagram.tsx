import type { CanvasModel } from "@shared/runtime/review-explainer/contracts";
import { useEffect, useRef, useState } from "react";
import { explainerUi as UI } from "./ui";

export type CodeLocation = { path: string; side: "old" | "new"; line: number };
const evidenceLabels = { assertion: "原断言", evidence: "已有证据", inference: "条件推演" };

/** Fixed layout only. Model text is drawn as text; it never becomes DOM markup or script. */
export function ExplanationDiagram({
  model,
  onLocate,
}: { model: CanvasModel; onLocate: (location: CodeLocation) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const context = canvas.getContext("2d");
      if (!context || model.nodes.length === 0 || model.nodes.length > 24) {
        setAvailable(false);
        return;
      }
      const sequence = model.template === "sequence" && (model.participants?.length ?? 0) > 0;
      const participants = sequence ? (model.participants ?? []) : [];
      if (participants.length > 6) {
        setAvailable(false);
        return;
      }
      const width = sequence ? Math.max(380, participants.length * 150) : 380;
      const height = 52 + model.nodes.length * 87;
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * scale;
      canvas.height = height * scale;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.scale(scale, scale);
      context.clearRect(0, 0, width, height);
      const positions = new Map<string, { x: number; y: number; width: number; height: number }>();
      const participantX = (index: number) => ((index + 0.5) * width) / participants.length;
      const label = (text: string, x: number, y: number, color = "#e7e9ee", size = 12) => {
        context.font = `${size}px -apple-system, "PingFang SC", sans-serif`;
        context.fillStyle = color;
        context.textAlign = "center";
        context.fillText(text, x, y);
      };
      for (const [index, participant] of participants.entries()) {
        const x = participantX(index);
        label(participant.label, x, 19, "#b2b7c2", 11);
        context.strokeStyle = "#454b55";
        context.setLineDash([3, 5]);
        context.beginPath();
        context.moveTo(x, 30);
        context.lineTo(x, height - 10);
        context.stroke();
      }
      context.setLineDash([]);
      for (const [index, node] of model.nodes.entries()) {
        const actorIndex = Math.max(
          0,
          participants.findIndex((participant) => participant.id === node.actor),
        );
        const nodeWidth = sequence ? Math.min(132, width / participants.length - 14) : 336;
        const x = sequence ? participantX(actorIndex) : width / 2;
        positions.set(node.id, {
          x: x - nodeWidth / 2,
          y: 39 + index * 87,
          width: nodeWidth,
          height: 59,
        });
      }
      for (const edge of model.edges) {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) continue;
        const inference = model.nodes.find((node) => node.id === edge.to)?.evidence === "inference";
        const x1 = from.x + from.width / 2;
        const y1 = from.y + from.height;
        const x2 = to.x + to.width / 2;
        const y2 = to.y;
        context.strokeStyle = inference ? "#c9b18a" : "#8cb4e8";
        context.fillStyle = context.strokeStyle;
        context.setLineDash(inference ? [5, 4] : []);
        context.lineWidth = 1.2;
        context.beginPath();
        context.moveTo(x1, y1);
        context.lineTo(x2, y2 - 3);
        context.stroke();
        context.setLineDash([]);
        const angle = Math.atan2(y2 - y1, x2 - x1);
        context.beginPath();
        context.moveTo(x2, y2 - 2);
        context.lineTo(x2 - 6 * Math.cos(angle - 0.5), y2 - 2 - 6 * Math.sin(angle - 0.5));
        context.lineTo(x2 - 6 * Math.cos(angle + 0.5), y2 - 2 - 6 * Math.sin(angle + 0.5));
        context.closePath();
        context.fill();
      }
      for (const [index, node] of model.nodes.entries()) {
        const box = positions.get(node.id);
        if (!box) continue;
        context.fillStyle = "#22262d";
        context.strokeStyle = node.evidence === "inference" ? "#c9b18a" : "#596473";
        context.setLineDash(node.evidence === "inference" ? [4, 3] : []);
        context.fillRect(box.x, box.y, box.width, box.height);
        context.strokeRect(box.x, box.y, box.width, box.height);
        context.setLineDash([]);
        const length = Math.max(9, Math.floor(box.width / 8));
        const characters = Array.from(node.label);
        const lines: string[] = [];
        for (let i = 0; i < characters.length && lines.length < 2; i += length)
          lines.push(characters.slice(i, i + length).join(""));
        lines.forEach((line, row) =>
          label(line, box.x + box.width / 2, box.y + 19 + row * 15, "#e7e9ee", 11),
        );
        label(
          `${index + 1} · ${evidenceLabels[node.evidence]}`,
          box.x + box.width / 2,
          box.y + 50,
          node.evidence === "inference" ? "#c9b18a" : "#929aa7",
          9,
        );
      }
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, [model]);

  return (
    <div className="ck-ex-diagram">
      <div className="ck-ex-canvas-scroll" hidden={!available}>
        <canvas
          ref={canvasRef}
          data-testid={UI.canvas}
          aria-label={`${model.template === "sequence" ? "时序" : "流程"}图，完整文字步骤位于下方`}
          role="img"
        />
      </div>
      {!available ? (
        <p className="ck-ex-muted">图形不可用，以下文字步骤保留完整解释。</p>
      ) : (
        <p className="ck-ex-muted">固定图形模板 · 虚线表示条件推演 · 非运行回放</p>
      )}
      <ol data-testid={UI.canvasFallback} className="ck-ex-graph-text">
        {model.nodes.map((node) => (
          <li key={node.id}>
            <span className={`ck-ex-evidence-label ${node.evidence}`}>
              {evidenceLabels[node.evidence]}
            </span>
            <span>{node.label}</span>
            {node.location ? (
              <button
                type="button"
                onClick={() => {
                  if (node.location) onLocate(node.location);
                }}
              >
                查看 {node.location.side === "old" ? "旧" : "新"}侧 L{node.location.line}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
