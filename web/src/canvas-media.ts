import type { CanvasGraph } from "./canvas-commands";
import { canvasSnapshot } from "./domain";

type Viewport = { x: number; y: number; zoom: number };
export type CanvasMediaBaseline = { revision: number; fingerprint: string };
export function canvasMediaBaseline(
  graph: CanvasGraph,
  viewport: Viewport,
  revision: number,
): CanvasMediaBaseline {
  return {
    revision,
    fingerprint: JSON.stringify(
      canvasSnapshot(graph.nodes, graph.edges, viewport, revision),
    ),
  };
}
export function canApplyCanvasMediaResult(
  baseline: CanvasMediaBaseline | null,
  graph: CanvasGraph,
  viewport: Viewport,
  revision: number,
) {
  return (
    !!baseline &&
    baseline.revision === revision &&
    baseline.fingerprint ===
      canvasMediaBaseline(graph, viewport, revision).fingerprint
  );
}
export function canvasMediaTarget(
  graph: CanvasGraph,
  nodeId: string,
  sourceUrl: string,
  revision: number,
) {
  const source = graph.nodes.find((node) => node.id === nodeId);
  if (
    !source ||
    !["image", "video", "audio"].includes(source.data.kind) ||
    source.data.url !== sourceUrl
  )
    throw new Error("源节点已变化，请关闭媒体编辑后重新选择");
  if (!sourceUrl.startsWith("/media/"))
    throw new Error("请先上传本地媒体后再编辑");
  if (!Number.isInteger(revision) || revision < 0)
    throw new Error("画布尚未保存，请保存后重试");
  return { node_id: nodeId, canvas_revision: revision, output_node: true };
}
