import { describe, expect, it } from "vitest";
import { adoptUserNodes, type InternalNodeBase } from "@xyflow/system";
import {
  cloneSubgraph,
  CanvasGraphHistory,
  deleteSelection,
  parseCanvasGraph,
  selectedSubgraph,
  serializeCanvasGraph,
  type CanvasGraph,
} from "./canvas-commands";

function graph(): CanvasGraph {
  return {
    nodes: [
      {
        id: "a",
        type: "media",
        position: { x: 5, y: 10 },
        selected: true,
        data: {
          kind: "text",
          label: "A",
          text: "a",
          node_id: "b",
          asset_id: "a",
          nested: { nodeId: "outside" },
          nodeIds: ["b", "outside"],
        },
      },
      {
        id: "b",
        type: "media",
        position: { x: 100, y: 20 },
        selected: true,
        data: {
          kind: "image",
          label: "B",
          text: "prompt",
          url: "https://example.com/b.png",
        },
      },
      {
        id: "outside",
        type: "media",
        position: { x: 200, y: 30 },
        data: { kind: "text", label: "C", text: "c" },
      },
    ],
    edges: [
      {
        id: "ab",
        source: "a",
        target: "b",
        sourceHandle: "output",
        data: { note: "kept" },
      },
      { id: "bc", source: "b", target: "outside" },
    ],
  };
}

function hierarchy(): CanvasGraph {
  return {
    nodes: [
      {
        id: "parent",
        type: "media",
        position: { x: 100, y: 200 },
        width: 400,
        height: 300,
        data: { kind: "text", label: "Parent", text: "" },
      },
      {
        id: "child",
        type: "media",
        parentId: "parent",
        extent: "parent",
        expandParent: true,
        position: { x: 20, y: 30 },
        width: 200,
        height: 100,
        data: { kind: "text", label: "Child", text: "" },
      },
      {
        id: "grandchild",
        type: "media",
        parentId: "child",
        position: { x: 5, y: 8 },
        width: 50,
        height: 40,
        data: { kind: "text", label: "Grandchild", text: "" },
      },
      {
        id: "unrelated",
        type: "media",
        position: { x: 700, y: 200 },
        data: { kind: "text", label: "Unrelated", text: "" },
      },
    ],
    edges: [
      { id: "parent-child", source: "parent", target: "child" },
      { id: "child-grandchild", source: "child", target: "grandchild" },
      { id: "external", source: "grandchild", target: "unrelated" },
      { id: "unrelated-loop", source: "unrelated", target: "unrelated" },
    ],
  };
}

describe("canvas graph commands", () => {
  it("copies selected nodes and all internal edges without mutating the source", () => {
    const original = graph();
    const copied = selectedSubgraph(original);
    expect(copied.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(copied.edges.map((edge) => edge.id)).toEqual(["ab"]);
    copied.nodes[0].data.label = "changed";
    expect(original.nodes[0].data.label).toBe("A");
    expect(original.edges).toHaveLength(2);
  });

  it("duplicates with fresh IDs, offset positions and matching internal endpoints", () => {
    const original = graph();
    let sequence = 0;
    const copied = cloneSubgraph(
      selectedSubgraph(original),
      () => `new-${++sequence}`,
    );
    expect(
      copied.nodes.map((node) => [node.id, node.position, node.selected]),
    ).toEqual([
      ["new-1", { x: 53, y: 58 }, true],
      ["new-2", { x: 148, y: 68 }, true],
    ]);
    expect(copied.edges).toEqual([
      {
        id: "new-3",
        source: "new-1",
        target: "new-2",
        sourceHandle: "output",
        data: { note: "kept" },
        selected: true,
      },
    ]);
    expect(original.nodes[0].position).toEqual({ x: 5, y: 10 });
  });

  it("rewrites explicit internal references while preserving external and asset references on paste", () => {
    let sequence = 0;
    const copied = cloneSubgraph(
      selectedSubgraph(graph()),
      () => `new-${++sequence}`,
    );
    expect(copied.nodes[0].data).toEqual({
      kind: "text",
      label: "A",
      text: "a",
      node_id: "new-2",
      asset_id: "a",
      nested: { nodeId: "outside" },
      nodeIds: ["new-2", "outside"],
    });
  });

  it("deletes selected nodes and incident edges while preserving unrelated edges", () => {
    const original = graph();
    original.nodes[0].selected = false;
    original.edges.push({ id: "ac", source: "a", target: "outside" });
    const result = deleteSelection(original);
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "outside"]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["ac"]);
    expect(original.nodes).toHaveLength(3);
  });

  it("round trips a portable clipboard with a viewport and accepts existing canvas exports", () => {
    const original = { ...graph(), viewport: { x: 10, y: -20, zoom: 0.5 } };
    const result = parseCanvasGraph(serializeCanvasGraph(original));
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "b", "outside"]);
    expect(result.edges).toHaveLength(2);
    expect(result.viewport).toEqual({ x: 10, y: -20, zoom: 0.5 });
    expect(result.nodes[0].selected).toBeUndefined();
    expect(parseCanvasGraph(JSON.stringify(original)).nodes).toHaveLength(3);
  });

  it("copies a child without its parent as a portable absolute-positioned node", () => {
    const original = hierarchy();
    original.nodes[1].selected = true;
    const copied = selectedSubgraph(original);
    expect(copied.nodes[0].position).toEqual({ x: 120, y: 230 });
    expect(copied.nodes[0].parentId).toBeUndefined();
    expect(copied.nodes[0].extent).toBeUndefined();
    expect(copied.nodes[0].expandParent).toBeUndefined();
    const imported = parseCanvasGraph(serializeCanvasGraph(copied));
    const pasted = cloneSubgraph(imported, () => "pasted-child");
    expect(pasted.nodes[0].position).toEqual({ x: 168, y: 278 });
    const lookup = new Map<string, InternalNodeBase>();
    expect(() => adoptUserNodes(pasted.nodes, lookup, new Map())).not.toThrow();
    expect(lookup.get("pasted-child")?.internals.positionAbsolute).toEqual({
      x: 168,
      y: 278,
    });
    expect(original.nodes[1].parentId).toBe("parent");
  });

  it("offsets a selected hierarchy once while retaining child-relative positions", () => {
    const original = hierarchy();
    original.nodes[0].selected = true;
    original.nodes[1].selected = true;
    let sequence = 0;
    const pasted = cloneSubgraph(
      parseCanvasGraph(serializeCanvasGraph(selectedSubgraph(original))),
      () => `clone-${++sequence}`,
    );
    expect(pasted.nodes[0].position).toEqual({ x: 148, y: 248 });
    expect(pasted.nodes[1].parentId).toBe("clone-1");
    expect(pasted.nodes[1].position).toEqual({ x: 20, y: 30 });
    const lookup = new Map<string, InternalNodeBase>();
    adoptUserNodes(pasted.nodes, lookup, new Map());
    expect(lookup.get("clone-2")?.internals.positionAbsolute).toEqual({
      x: 168,
      y: 278,
    });
  });

  it("flattens nested child selections using ancestor origins and dimensions", () => {
    const original = hierarchy();
    original.nodes[0].origin = [0.5, 0.5];
    original.nodes[2].selected = true;
    const copied = selectedSubgraph(original);
    expect(copied.nodes[0].position).toEqual({ x: -75, y: 88 });
    expect(copied.nodes[0].parentId).toBeUndefined();
  });

  it("deletes every descendant and incident edge when just the parent is selected", () => {
    const original = hierarchy();
    original.nodes[0].selected = true;
    const result = deleteSelection(original);
    expect(result.nodes.map((node) => node.id)).toEqual(["unrelated"]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["unrelated-loop"]);
    expect(() => parseCanvasGraph(serializeCanvasGraph(result))).not.toThrow();
    expect(original.nodes).toHaveLength(4);
  });

  it("single-node deletion uses explicit IDs and preserves unrelated selections", () => {
    const original = hierarchy();
    original.nodes[3].selected = true;
    original.edges[3].selected = true;
    const result = deleteSelection(original, ["child"]);
    expect(result.nodes.map((node) => node.id)).toEqual([
      "parent",
      "unrelated",
    ]);
    expect(result.edges.map((edge) => edge.id)).toEqual(["unrelated-loop"]);
  });

  it("undo restores a recursively deleted hierarchy with all edges in one step", () => {
    const original = hierarchy();
    original.nodes[0].selected = true;
    const history = new CanvasGraphHistory();
    history.record(original);
    const deleted = deleteSelection(original);
    expect(history.undo(deleted)).toEqual(original);
    expect(history.undo(original)).toBeUndefined();
    expect(history.redo(original)).toEqual(deleted);
  });

  it("accepts supported geometry and hands it to installed React Flow safely", () => {
    const imported = parseCanvasGraph(
      JSON.stringify({
        nodes: [
          {
            ...graph().nodes[0],
            width: 100,
            height: 80,
            origin: [0.5, 0.5],
            extent: [
              [0, 0],
              [500, 500],
            ],
            handles: [{ type: "source", position: "right", x: 100, y: 40 }],
          },
        ],
        edges: [],
      }),
    );
    const lookup = new Map<string, InternalNodeBase>();
    expect(() =>
      adoptUserNodes(imported.nodes, lookup, new Map()),
    ).not.toThrow();
    expect(lookup.get("a")?.internals.positionAbsolute).toEqual({ x: 0, y: 0 });
    expect(lookup.get("a")?.internals.handleBounds?.source?.[0].position).toBe(
      "right",
    );
  });

  it("rejects the malformed extent that would crash installed React Flow adoption", () => {
    const value = JSON.stringify({
      nodes: [{ ...graph().nodes[0], extent: [] }],
      edges: [],
    });
    expect(() =>
      adoptUserNodes(JSON.parse(value).nodes, new Map(), new Map()),
    ).toThrow();
    expect(() => parseCanvasGraph(value)).toThrow();
  });

  it.each([
    [
      "malformed origin",
      JSON.stringify({
        nodes: [{ ...graph().nodes[0], origin: {} }],
        edges: [],
      }),
    ],
    [
      "malformed handles",
      JSON.stringify({
        nodes: [{ ...graph().nodes[0], handles: {} }],
        edges: [],
      }),
    ],
    [
      "malformed handle position",
      JSON.stringify({
        nodes: [
          {
            ...graph().nodes[0],
            handles: [{ type: "source", position: "wrong", x: 0, y: 0 }],
          },
        ],
        edges: [],
      }),
    ],
    [
      "DOM escape hatch",
      JSON.stringify({
        nodes: [
          {
            ...graph().nodes[0],
            domAttributes: { dangerouslySetInnerHTML: { __html: "unsafe" } },
          },
        ],
        edges: [],
      }),
    ],
    ["invalid JSON", "<script>alert(1)</script>"],
    ["missing arrays", "{}"],
    [
      "duplicate nodes",
      JSON.stringify({
        nodes: [graph().nodes[0], graph().nodes[0]],
        edges: [],
      }),
    ],
    [
      "dangling edge",
      JSON.stringify({ nodes: [graph().nodes[0]], edges: graph().edges }),
    ],
    [
      "duplicate edges",
      JSON.stringify({
        ...graph(),
        edges: [graph().edges[0], graph().edges[0]],
      }),
    ],
    [
      "nonfinite position",
      JSON.stringify({
        nodes: [{ ...graph().nodes[0], position: { x: null, y: 2 } }],
        edges: [],
      }),
    ],
    [
      "unsupported type",
      JSON.stringify({
        nodes: [{ ...graph().nodes[0], type: "html" }],
        edges: [],
      }),
    ],
    [
      "missing data",
      JSON.stringify({
        nodes: [{ ...graph().nodes[0], data: null }],
        edges: [],
      }),
    ],
    [
      "unsafe URL",
      JSON.stringify({
        nodes: [
          {
            ...graph().nodes[0],
            data: {
              kind: "image",
              label: "x",
              text: "",
              url: "javascript:alert(1)",
            },
          },
        ],
        edges: [],
      }),
    ],
    [
      "unsafe viewport",
      JSON.stringify({ ...graph(), viewport: { x: 0, y: 0, zoom: 0 } }),
    ],
    [
      "unknown version",
      JSON.stringify({ ...graph(), format: "ai-series-canvas", version: 99 }),
    ],
    [
      "malformed node style",
      JSON.stringify({
        nodes: [{ ...graph().nodes[0], style: "invalid" }],
        edges: [],
      }),
    ],
    [
      "malformed visibility",
      JSON.stringify({
        nodes: [{ ...graph().nodes[0], hidden: "false" }],
        edges: [],
      }),
    ],
    [
      "malformed dimensions",
      JSON.stringify({
        nodes: [{ ...graph().nodes[0], measured: { width: -5, height: 4 } }],
        edges: [],
      }),
    ],
    [
      "object edge label",
      JSON.stringify({
        ...graph(),
        edges: [{ ...graph().edges[0], label: { html: "not a child" } }],
      }),
    ],
    [
      "malformed edge marker",
      JSON.stringify({
        ...graph(),
        edges: [{ ...graph().edges[0], markerEnd: [] }],
      }),
    ],
    ["prototype keys", '{"nodes":[],"edges":[],"__proto__":{"polluted":true}}'],
  ])("rejects %s before a graph can be applied", (_, value) => {
    expect(() => parseCanvasGraph(value)).toThrow();
  });

  it("does not silently drop dangling edges or accept duplicate generated IDs", () => {
    expect(() =>
      cloneSubgraph({ nodes: [graph().nodes[0]], edges: graph().edges }),
    ).toThrow();
    expect(() =>
      cloneSubgraph(selectedSubgraph(graph()), () => "collision"),
    ).toThrow();
  });
});
