import type { Edge, Node } from "@xyflow/react";
import {
  adoptUserNodes,
  getNodeDimensions,
  type InternalNodeBase,
} from "@xyflow/system";

export type CanvasNodeData = {
  label: string;
  text: string;
  url?: string;
  kind: string;
  [key: string]: unknown;
};
export type CanvasGraph = {
  nodes: Node<CanvasNodeData>[];
  edges: Edge[];
  viewport?: { x: number; y: number; zoom: number };
};

const referenceKeys = new Set([
  "nodeId",
  "node_id",
  "sourceNodeId",
  "source_node_id",
  "targetNodeId",
  "target_node_id",
  "referenceNodeId",
  "reference_node_id",
  "parentId",
]);
const referenceLists = new Set([
  "nodeIds",
  "node_ids",
  "referenceNodeIds",
  "reference_node_ids",
]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
function invalid(message: string): never {
  throw new Error(`画布数据无效：${message}`);
}
function checkJSON(value: unknown, depth = 0): void {
  if (depth > 40) invalid("嵌套层级过深");
  if (Array.isArray(value)) {
    for (const child of value) checkJSON(child, depth + 1);
  } else if (record(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        invalid("包含不支持的字段");
      checkJSON(child, depth + 1);
    }
  } else if (typeof value === "number" && !Number.isFinite(value))
    invalid("数值必须有限");
  else if (
    !["string", "number", "boolean"].includes(typeof value) &&
    value !== null &&
    value !== undefined
  )
    invalid("仅支持 JSON 数据");
}
function safeMediaURL(value: string) {
  return /^(https?:\/\/|blob:|\/[^/]|data:(image\/(png|jpeg|gif|webp|avif)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+);)/i.test(
    value,
  );
}

function checkStyle(value: unknown) {
  if (value === undefined || value === null) return;
  if (
    !record(value) ||
    Object.values(value).some(
      (item) => item !== null && typeof item !== "string" && !finite(item),
    )
  )
    invalid("样式必须是有效的属性对象");
}
function checkOptionalProperties(value: Record<string, unknown>) {
  for (const key of [
    "selected",
    "hidden",
    "draggable",
    "dragging",
    "selectable",
    "connectable",
    "deletable",
    "focusable",
    "resizing",
    "animated",
    "expandParent",
  ]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      invalid("节点或连线状态不正确");
  }
  for (const key of [
    "width",
    "height",
    "initialWidth",
    "initialHeight",
    "zIndex",
  ]) {
    if (
      value[key] !== undefined &&
      (!finite(value[key]) || (key !== "zIndex" && value[key] < 0))
    )
      invalid("节点尺寸不正确");
  }
  checkStyle(value.style);
}

const nodeProperties = new Set([
  "id",
  "type",
  "position",
  "data",
  "sourcePosition",
  "targetPosition",
  "hidden",
  "selected",
  "dragging",
  "draggable",
  "selectable",
  "connectable",
  "deletable",
  "dragHandle",
  "width",
  "height",
  "initialWidth",
  "initialHeight",
  "parentId",
  "zIndex",
  "extent",
  "expandParent",
  "ariaLabel",
  "origin",
  "handles",
  "measured",
  "style",
  "className",
  "resizing",
  "focusable",
  "ariaRole",
]);
const edgeProperties = new Set([
  "id",
  "type",
  "source",
  "target",
  "sourceHandle",
  "targetHandle",
  "animated",
  "hidden",
  "deletable",
  "selectable",
  "data",
  "selected",
  "markerStart",
  "markerEnd",
  "zIndex",
  "ariaLabel",
  "interactionWidth",
  "label",
  "labelStyle",
  "labelShowBg",
  "labelBgStyle",
  "labelBgPadding",
  "labelBgBorderRadius",
  "style",
  "className",
  "reconnectable",
  "focusable",
  "ariaRole",
  "pathOptions",
]);
const pair = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every(finite);
function checkProperties(value: Record<string, unknown>, allowed: Set<string>) {
  if (Object.keys(value).some((key) => !allowed.has(key)))
    invalid("包含不支持的渲染属性；请将自定义内容放在 data 中");
  for (const key of ["className", "ariaLabel", "ariaRole", "dragHandle"]) {
    if (value[key] !== undefined && typeof value[key] !== "string")
      invalid("节点或连线属性类型不正确");
  }
}
function checkNodeGeometry(node: Record<string, unknown>) {
  if (
    node.origin !== undefined &&
    (!pair(node.origin) ||
      node.origin.some((coordinate) => coordinate < 0 || coordinate > 1))
  )
    invalid("节点原点不正确");
  const extent = node.extent;
  if (
    extent !== undefined &&
    extent !== null &&
    extent !== "parent" &&
    (!Array.isArray(extent) ||
      extent.length !== 2 ||
      !pair(extent[0]) ||
      !pair(extent[1]) ||
      extent[0][0] > extent[1][0] ||
      extent[0][1] > extent[1][1])
  )
    invalid("节点移动范围不正确");
  if (extent === "parent" && !node.parentId) invalid("父节点范围缺少父节点");
  for (const key of ["sourcePosition", "targetPosition"]) {
    if (
      node[key] !== undefined &&
      !["top", "right", "bottom", "left"].includes(String(node[key]))
    )
      invalid("节点接口位置不正确");
  }
  if (node.handles !== undefined) {
    if (!Array.isArray(node.handles)) invalid("节点接口必须为数组");
    for (const handle of node.handles) {
      if (
        !record(handle) ||
        !finite(handle.x) ||
        !finite(handle.y) ||
        !["source", "target"].includes(String(handle.type)) ||
        !["top", "right", "bottom", "left"].includes(String(handle.position)) ||
        (handle.id !== undefined &&
          handle.id !== null &&
          typeof handle.id !== "string")
      )
        invalid("节点接口不正确");
      for (const key of ["width", "height"])
        if (
          handle[key] !== undefined &&
          (!finite(handle[key]) || handle[key] < 0)
        )
          invalid("节点接口尺寸不正确");
    }
  }
}
function checkEdgeGeometry(edge: Record<string, unknown>) {
  for (const key of ["interactionWidth", "labelBgBorderRadius"]) {
    if (edge[key] !== undefined && (!finite(edge[key]) || edge[key] < 0))
      invalid("连线尺寸不正确");
  }
  if (
    edge.labelBgPadding !== undefined &&
    (!pair(edge.labelBgPadding) ||
      edge.labelBgPadding.some((value) => value < 0))
  )
    invalid("连线标签边距不正确");
  if (edge.labelShowBg !== undefined && typeof edge.labelShowBg !== "boolean")
    invalid("连线标签状态不正确");
  if (
    edge.reconnectable !== undefined &&
    typeof edge.reconnectable !== "boolean" &&
    !["source", "target"].includes(String(edge.reconnectable))
  )
    invalid("连线连接状态不正确");
  if (
    edge.pathOptions !== undefined &&
    (!record(edge.pathOptions) ||
      Object.entries(edge.pathOptions).some(
        ([key, value]) =>
          !["offset", "borderRadius", "stepPosition", "curvature"].includes(
            key,
          ) || !finite(value),
      ))
  )
    invalid("连线路径参数不正确");
}

/** Accepts current exports and the versioned plain-text clipboard format. */
export function parseCanvasGraph(text: string): CanvasGraph {
  if (text.length > 5 * 1024 * 1024) invalid("文件超过 5 MB");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid("请选择有效的画布 JSON 文件");
  }
  checkJSON(value);
  if (
    !record(value) ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  )
    invalid("缺少 nodes 或 edges 数组");
  if (
    value.format !== undefined &&
    (value.format !== "ai-series-canvas" || value.version !== 1)
  )
    invalid("不支持的画布格式或版本");
  if (value.nodes.length > 2000 || value.edges.length > 6000)
    invalid("节点或连线过多");
  const ids = new Set<string>();
  for (const node of value.nodes) {
    if (!record(node) || !identifier(node.id) || ids.has(node.id))
      invalid("节点 ID 为空或重复");
    ids.add(node.id);
    checkProperties(node, nodeProperties);
    checkOptionalProperties(node);
    checkNodeGeometry(node);
    if (
      node.measured !== undefined &&
      (!record(node.measured) ||
        Object.entries(node.measured).some(
          ([key, size]) =>
            !["width", "height"].includes(key) || !finite(size) || size < 0,
        ))
    )
      invalid("节点测量尺寸不正确");
    if (node.type !== undefined && node.type !== "media")
      invalid("不支持的节点类型");
    if (
      !record(node.position) ||
      !finite(node.position.x) ||
      !finite(node.position.y)
    )
      invalid("节点坐标不正确");
    if (
      !record(node.data) ||
      !["text", "image", "video", "audio"].includes(String(node.data.kind)) ||
      typeof node.data.label !== "string" ||
      typeof node.data.text !== "string"
    )
      invalid("节点内容不完整");
    if (
      node.data.url !== undefined &&
      (typeof node.data.url !== "string" ||
        (node.data.url !== "" && !safeMediaURL(node.data.url)))
    )
      invalid("素材地址不受支持");
    if (
      node.parentId !== undefined &&
      (!identifier(node.parentId) || node.parentId === node.id)
    )
      invalid("父节点引用不正确");
  }
  // React Flow requires parents before children and cannot render missing/cyclic parents.
  const prior = new Set<string>();
  for (const node of value.nodes) {
    if (node.parentId !== undefined && !prior.has(node.parentId))
      invalid("父节点不存在或顺序不正确");
    prior.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (!record(edge) || !identifier(edge.id) || edgeIds.has(edge.id))
      invalid("连线 ID 为空或重复");
    edgeIds.add(edge.id);
    checkProperties(edge, edgeProperties);
    checkOptionalProperties(edge);
    checkEdgeGeometry(edge);
    if (
      edge.label !== undefined &&
      edge.label !== null &&
      typeof edge.label !== "string" &&
      !finite(edge.label)
    )
      invalid("连线标签不正确");
    for (const key of ["labelStyle", "labelBgStyle"]) checkStyle(edge[key]);
    for (const key of ["markerStart", "markerEnd"]) {
      const marker = edge[key];
      if (
        marker !== undefined &&
        typeof marker !== "string" &&
        (!record(marker) ||
          !["arrow", "arrowclosed"].includes(String(marker.type)))
      )
        invalid("连线箭头不正确");
      if (record(marker)) {
        for (const field of ["width", "height", "strokeWidth"])
          if (
            marker[field] !== undefined &&
            (!finite(marker[field]) || marker[field] < 0)
          )
            invalid("连线箭头尺寸不正确");
        for (const field of ["color", "markerUnits", "orient"])
          if (
            marker[field] !== undefined &&
            marker[field] !== null &&
            typeof marker[field] !== "string"
          )
            invalid("连线箭头属性不正确");
      }
    }
    if (edge.data !== undefined && !record(edge.data))
      invalid("连线内容不正确");
    if (
      !identifier(edge.source) ||
      !identifier(edge.target) ||
      !ids.has(edge.source) ||
      !ids.has(edge.target)
    )
      invalid("连线引用了不存在的节点");
    if (
      edge.type !== undefined &&
      !["default", "straight", "step", "smoothstep", "simplebezier"].includes(
        String(edge.type),
      )
    )
      invalid("不支持的连线类型");
    for (const key of ["sourceHandle", "targetHandle"]) {
      if (
        edge[key] !== undefined &&
        edge[key] !== null &&
        typeof edge[key] !== "string"
      )
        invalid("连线接口不正确");
    }
  }
  if (
    value.viewport !== undefined &&
    (!record(value.viewport) ||
      !finite(value.viewport.x) ||
      !finite(value.viewport.y) ||
      !finite(value.viewport.zoom) ||
      value.viewport.zoom < 0.15 ||
      value.viewport.zoom > 2)
  )
    invalid("视口不正确");
  return {
    nodes: value.nodes.map(
      ({ selected: _selected, dragging: _dragging, ...node }) => ({
        ...node,
        type: "media",
      }),
    ) as Node<CanvasNodeData>[],
    edges: value.edges.map(
      ({ selected: _selected, ...edge }) => edge,
    ) as Edge[],
    ...(value.viewport
      ? { viewport: value.viewport as CanvasGraph["viewport"] }
      : {}),
  };
}

export function serializeCanvasGraph(graph: CanvasGraph): string {
  return JSON.stringify(
    {
      format: "ai-series-canvas",
      version: 1,
      nodes: graph.nodes.map(
        ({ selected: _selected, dragging: _dragging, ...node }) => node,
      ),
      edges: graph.edges.map(({ selected: _selected, ...edge }) => edge),
      ...(graph.viewport ? { viewport: graph.viewport } : {}),
    },
    null,
    2,
  );
}

export function selectedSubgraph(graph: CanvasGraph): CanvasGraph {
  const nodes = graph.nodes.filter((node) => node.selected);
  const ids = new Set(nodes.map((node) => node.id));
  let lookup: Map<string, InternalNodeBase<Node<CanvasNodeData>>> | undefined;
  if (nodes.some((node) => node.parentId && !ids.has(node.parentId))) {
    lookup = new Map();
    adoptUserNodes(graph.nodes, lookup, new Map());
  }
  return structuredClone({
    nodes: nodes.map((node) => {
      if (!node.parentId || ids.has(node.parentId)) return node;
      const absolute = lookup?.get(node.id)?.internals.positionAbsolute;
      if (!absolute) invalid("无法计算子节点的绝对坐标");
      const {
        parentId: _parent,
        extent: _extent,
        expandParent: _expand,
        ...flattened
      } = node;
      const dimensions = getNodeDimensions(node);
      const origin = node.origin || [0, 0];
      return {
        ...flattened,
        position: {
          x: absolute.x + dimensions.width * origin[0],
          y: absolute.y + dimensions.height * origin[1],
        },
      };
    }),
    edges: graph.edges.filter(
      (edge) => ids.has(edge.source) && ids.has(edge.target),
    ),
  });
}

function remapReferences(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value))
    return value.map((child) => remapReferences(child, ids));
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      referenceKeys.has(key) && typeof child === "string"
        ? ids.get(child) || child
        : referenceLists.has(key) && Array.isArray(child)
          ? child.map((id) =>
              typeof id === "string"
                ? ids.get(id) || id
                : remapReferences(id, ids),
            )
          : remapReferences(child, ids),
    ]),
  );
}

/** IDs only remap explicit node references; arbitrary text and external asset IDs stay intact. */
export function cloneSubgraph(
  graph: CanvasGraph,
  makeId: () => string = () => crypto.randomUUID(),
  offset = { x: 48, y: 48 },
): CanvasGraph {
  const ids = new Map<string, string>();
  const generated = new Set<string>([
    ...graph.nodes.map((node) => node.id),
    ...graph.edges.map((edge) => edge.id),
  ]);
  const fresh = () => {
    const id = makeId();
    if (!identifier(id) || generated.has(id)) invalid("新 ID 冲突");
    generated.add(id);
    return id;
  };
  for (const node of graph.nodes) {
    if (ids.has(node.id)) invalid("节点 ID 重复");
    ids.set(node.id, fresh());
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target))
      invalid("连线引用了不存在的节点");
  }
  return {
    nodes: graph.nodes.map((node) => ({
      ...structuredClone(node),
      id: ids.get(node.id)!,
      selected: true,
      dragging: false,
      position: {
        x:
          node.position.x +
          (node.parentId && ids.has(node.parentId) ? 0 : offset.x),
        y:
          node.position.y +
          (node.parentId && ids.has(node.parentId) ? 0 : offset.y),
      },
      ...(node.parentId
        ? { parentId: ids.get(node.parentId) || node.parentId }
        : {}),
      data: remapReferences(structuredClone(node.data), ids) as CanvasNodeData,
    })),
    edges: graph.edges.map((edge) => ({
      ...structuredClone(edge),
      id: fresh(),
      source: ids.get(edge.source)!,
      target: ids.get(edge.target)!,
      selected: true,
      ...(edge.data
        ? {
            data: remapReferences(structuredClone(edge.data), ids) as Record<
              string,
              unknown
            >,
          }
        : {}),
    })),
  };
}

export function deleteSelection(
  graph: CanvasGraph,
  nodeIds?: string[],
): CanvasGraph {
  const removed = new Set(
    nodeIds ||
      graph.nodes.filter((node) => node.selected).map((node) => node.id),
  );
  let found = true;
  while (found) {
    found = false;
    for (const node of graph.nodes) {
      if (
        node.parentId &&
        removed.has(node.parentId) &&
        !removed.has(node.id)
      ) {
        removed.add(node.id);
        found = true;
      }
    }
  }
  return {
    nodes: graph.nodes.filter((node) => !removed.has(node.id)),
    edges: graph.edges.filter(
      (edge) =>
        (nodeIds !== undefined || !edge.selected) &&
        !removed.has(edge.source) &&
        !removed.has(edge.target),
    ),
  };
}

/** Each user command records one detached snapshot, including recursively removed nodes/edges. */
export class CanvasGraphHistory {
  private undoStack: CanvasGraph[] = [];
  private redoStack: CanvasGraph[] = [];
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }
  record(graph: CanvasGraph) {
    this.undoStack.push(structuredClone(graph));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }
  undo(current: CanvasGraph): CanvasGraph | undefined {
    const previous = this.undoStack.pop();
    if (previous) this.redoStack.push(structuredClone(current));
    return previous;
  }
  redo(current: CanvasGraph): CanvasGraph | undefined {
    const next = this.redoStack.pop();
    if (next) this.undoStack.push(structuredClone(current));
    return next;
  }
}
