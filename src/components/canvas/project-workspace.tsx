"use client";

import {
  Background,
  BackgroundVariant,
  EdgeChange,
  MarkerType,
  NodeChange,
  ReactFlow,
  ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ArrowLeftIcon,
  BranchIcon,
  FitIcon,
  LayoutIcon,
  RefreshIcon,
  SparklesIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "@/components/icons";
import {
  CreativeFlowEdge,
  ImageFlowNode,
  normalizeProjectDetail,
  ProjectDetail,
  readApiJson,
  ReferenceRecord,
} from "@/components/project-types";
import { useWorkspaceStore } from "@/store/workspace-store";

import { layoutGraph } from "./graph-layout";
import { ImageNode } from "./image-node";
import { Inspector } from "./inspector";
import { JobStatus } from "./job-status";

const nodeTypes = { image: ImageNode };

function toFlowEdges(detail: ProjectDetail): CreativeFlowEdge[] {
  const images = new Map(detail.images.map((image) => [image.id, image]));
  return detail.edges
    .filter(
      (edge) =>
        images.has(edge.sourceImageId) && images.has(edge.targetImageId),
    )
    .map((edge) => {
      const target = images.get(edge.targetImageId);
      const targetState = target?.status?.toUpperCase();
      const active = Boolean(
        target?.provisional &&
        targetState !== "FAILED" &&
        targetState !== "ERROR",
      );
      return {
        id: edge.id,
        source: edge.sourceImageId,
        target: edge.targetImageId,
        label: edge.label,
        type: "smoothstep",
        data: { edge },
        animated: active,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        labelBgPadding: [8, 5],
        labelBgBorderRadius: 8,
        labelShowBg: true,
      } satisfies CreativeFlowEdge;
    });
}

function WorkspaceLoading() {
  return (
    <main className="workspace-loading">
      <div className="brand-mark">
        <BranchIcon size={21} />
      </div>
      <span className="loading-orbit">
        <i />
      </span>
      <h1>Opening exploration</h1>
      <p>Restoring the graph and its saved positions…</p>
    </main>
  );
}

export function ProjectWorkspace({ projectId }: { projectId: string }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<ImageFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CreativeFlowEdge>([]);
  const [instance, setInstance] = useState<ReactFlowInstance<
    ImageFlowNode,
    CreativeFlowEdge
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [layouting, setLayouting] = useState(false);
  const [savingPositions, setSavingPositions] = useState(false);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const provisionalIdsRef = useRef(new Set<string>());
  const locallyPersistedIdsRef = useRef(new Set<string>());
  const graphVersionRef = useRef(0);
  const initialFitRef = useRef(false);
  const resetWorkspace = useWorkspaceStore((state) => state.reset);
  const setSelection = useWorkspaceStore((state) => state.setSelection);
  const clearSelection = useWorkspaceStore((state) => state.clearSelection);
  const selection = useWorkspaceStore((state) => state.selection);
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen);

  const loadProject = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const response = await fetch(`/api/projects/${projectId}`, {
          cache: "no-store",
        });
        const body = await readApiJson(response);
        const next = normalizeProjectDetail(body);
        if (!next.project.id) next.project.id = projectId;
        setDetail(next);
        setFatalError(null);
      } catch (requestError) {
        const message =
          requestError instanceof Error
            ? requestError.message
            : "Could not open this project.";
        if (!silent) setFatalError(message);
        else setNotice(message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    resetWorkspace();
    positionsRef.current.clear();
    provisionalIdsRef.current.clear();
    locallyPersistedIdsRef.current.clear();
    initialFitRef.current = false;
    const timeout = window.setTimeout(() => void loadProject(), 0);
    return () => {
      window.clearTimeout(timeout);
      resetWorkspace();
    };
  }, [loadProject, resetWorkspace]);

  const hasActiveJob =
    detail?.jobs.some(
      (job) => job.state === "RUNNING" || job.state === "QUEUED",
    ) ?? false;
  useEffect(() => {
    if (!detail) return;
    const timer = window.setInterval(
      () => void loadProject(true),
      hasActiveJob ? 1600 : 12000,
    );
    return () => window.clearInterval(timer);
  }, [detail, hasActiveJob, loadProject]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const persistPositions = useCallback(
    async (values: { imageId: string; x: number; y: number }[]) => {
      const persistentValues = values.filter(
        ({ imageId }) => !provisionalIdsRef.current.has(imageId),
      );
      if (!persistentValues.length) return true;
      setSavingPositions(true);
      try {
        const response = await fetch(`/api/projects/${projectId}/positions`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positions: persistentValues }),
        });
        await readApiJson(response);
        persistentValues.forEach(({ imageId }) =>
          locallyPersistedIdsRef.current.add(imageId),
        );
        return true;
      } catch (requestError) {
        setNotice(
          requestError instanceof Error
            ? requestError.message
            : "Could not save canvas positions.",
        );
        return false;
      } finally {
        setSavingPositions(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (!detail) return;
    provisionalIdsRef.current = new Set(
      detail.images
        .filter((image) => image.provisional)
        .map((image) => image.id),
    );
    const version = ++graphVersionRef.current;
    const nextEdges = toFlowEdges(detail);
    const nextNodes: ImageFlowNode[] = detail.images.map((image) => {
      const localPosition = positionsRef.current.get(image.id);
      const persistedPosition = image.provisional
        ? undefined
        : (image.position ?? undefined);
      const position = localPosition ?? persistedPosition ?? { x: 0, y: 0 };
      const hasLayoutPosition = Boolean(localPosition || persistedPosition);
      const positionPersisted = Boolean(
        !image.provisional &&
        (persistedPosition || locallyPersistedIdsRef.current.has(image.id)),
      );
      return {
        id: image.id,
        type: "image",
        position,
        width: 232,
        height: 232,
        data: {
          image,
          imageUrl: image.thumbnailUrl ?? `/api/images/${image.id}?thumbnail=1`,
          label: `Round ${image.revision?.round || image.round || 1}, candidate ${image.candidateIndex + 1}`,
          __hasLayoutPosition: hasLayoutPosition,
          __positionPersisted: positionPersisted,
        },
      };
    });
    setEdges(nextEdges);
    void layoutGraph(nextNodes, nextEdges, "missing")
      .then((laidOut) => {
        if (version !== graphVersionRef.current) return;
        const needsPersistence = laidOut.filter(
          (node) =>
            !node.data.image.provisional &&
            node.data.__positionPersisted !== true,
        );
        const anchored = laidOut.map((node) => ({
          ...node,
          data: { ...node.data, __hasLayoutPosition: true },
        }));
        anchored.forEach((node) =>
          positionsRef.current.set(node.id, node.position),
        );
        setNodes(anchored);
        if (needsPersistence.length) {
          void persistPositions(
            needsPersistence.map((node) => ({
              imageId: node.id,
              x: node.position.x,
              y: node.position.y,
            })),
          ).then((saved) => {
            if (!saved) return;
            const savedIds = new Set(needsPersistence.map((node) => node.id));
            setNodes((current) =>
              current.map((node) =>
                savedIds.has(node.id)
                  ? {
                      ...node,
                      data: { ...node.data, __positionPersisted: true },
                    }
                  : node,
              ),
            );
          });
        }
        if (!initialFitRef.current && anchored.length) {
          initialFitRef.current = true;
          window.setTimeout(
            () =>
              void instance?.fitView({
                padding: 0.2,
                duration: 650,
                maxZoom: 1.15,
              }),
            60,
          );
        }
      })
      .catch(() => {
        if (version !== graphVersionRef.current) return;
        setNodes(nextNodes);
      });
  }, [detail, instance, persistPositions, setEdges, setNodes]);

  useEffect(() => {
    if (!selection || !detail) return;
    const exists =
      selection.kind === "image"
        ? detail.images.some((image) => image.id === selection.id)
        : detail.edges.some((edge) => edge.id === selection.id);
    if (!exists) clearSelection();
  }, [clearSelection, detail, selection]);

  const handleNodeDragStop = useCallback(
    (_: unknown, node: ImageFlowNode) => {
      positionsRef.current.set(node.id, node.position);
      if (node.data.image.provisional) return;
      void persistPositions([
        { imageId: node.id, x: node.position.x, y: node.position.y },
      ]);
    },
    [persistPositions],
  );

  const autoLayout = useCallback(async () => {
    if (!nodes.length || layouting) return;
    setLayouting(true);
    try {
      const laidOut = await layoutGraph(nodes, edges, "all");
      const anchored = laidOut.map((node) => ({
        ...node,
        data: { ...node.data, __hasLayoutPosition: true },
      }));
      anchored.forEach((node) =>
        positionsRef.current.set(node.id, node.position),
      );
      setNodes(anchored);
      const persistentNodes = anchored.filter(
        (node) => !node.data.image.provisional,
      );
      const saved = await persistPositions(
        persistentNodes.map((node) => ({
          imageId: node.id,
          x: node.position.x,
          y: node.position.y,
        })),
      );
      if (saved) {
        const savedIds = new Set(persistentNodes.map((node) => node.id));
        setNodes((current) =>
          current.map((node) =>
            savedIds.has(node.id)
              ? {
                  ...node,
                  data: { ...node.data, __positionPersisted: true },
                }
              : node,
          ),
        );
      }
      await instance?.fitView({ padding: 0.18, duration: 650, maxZoom: 1.15 });
    } catch {
      setNotice("Auto layout could not complete.");
    } finally {
      setLayouting(false);
    }
  }, [edges, instance, layouting, nodes, persistPositions, setNodes]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<ImageFlowNode>[]) => {
      onNodesChange(changes);
    },
    [onNodesChange],
  );
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<CreativeFlowEdge>[]) => {
      onEdgesChange(changes);
    },
    [onEdgesChange],
  );

  const onReferencesUploaded = useCallback((references: ReferenceRecord[]) => {
    setDetail((current) =>
      current
        ? {
            ...current,
            references: Array.from(
              new Map(
                [...current.references, ...references].map((reference) => [
                  reference.id,
                  reference,
                ]),
              ).values(),
            ),
          }
        : current,
    );
  }, []);

  const selectedImageForExplore = useMemo(() => {
    if (!selection || selection.kind !== "image" || !detail) return null;
    const image = detail.images.find((item) => item.id === selection.id);
    return image &&
      !image.provisional &&
      (image.status ?? "COMPLETED").toUpperCase() === "COMPLETED"
      ? image
      : null;
  }, [detail, selection]);

  if (loading && !detail) return <WorkspaceLoading />;
  if (fatalError && !detail) {
    return (
      <main className="workspace-error">
        <div className="brand-mark">
          <BranchIcon size={21} />
        </div>
        <h1>Couldn&apos;t open this exploration</h1>
        <p>{fatalError}</p>
        <div>
          <Link className="quiet-button" href="/">
            <ArrowLeftIcon size={16} />
            Back to projects
          </Link>
          <button
            className="primary-button"
            onClick={() => void loadProject()}
            type="button"
          >
            <RefreshIcon size={16} />
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (!detail) return null;

  const generatedCount = detail.images.filter((image) =>
    Boolean(image.originalUrl || image.thumbnailUrl),
  ).length;
  const failedAttemptCount = detail.images.filter(
    (image) =>
      image.provisional &&
      ["FAILED", "ERROR"].includes((image.status ?? "RUNNING").toUpperCase()),
  ).length;
  const inProgressCount = detail.images.filter(
    (image) =>
      image.provisional &&
      !image.originalUrl &&
      !image.thumbnailUrl &&
      !["FAILED", "ERROR"].includes((image.status ?? "RUNNING").toUpperCase()),
  ).length;

  return (
    <main className="workspace-shell">
      <ReactFlow<ImageFlowNode, CreativeFlowEdge>
        colorMode="dark"
        deleteKeyCode={null}
        edges={edges}
        edgesReconnectable={false}
        elementsSelectable
        elevateEdgesOnSelect
        fitView={false}
        maxZoom={2.6}
        minZoom={0.06}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable
        onEdgeClick={(_, edge) => setSelection({ kind: "edge", id: edge.id })}
        onEdgesChange={handleEdgesChange}
        onInit={setInstance}
        onNodeClick={(_, node) => setSelection({ kind: "image", id: node.id })}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodesChange}
        onPaneClick={clearSelection}
        panOnScroll
        selectionOnDrag={false}
        zoomOnDoubleClick={false}
      >
        <Background
          color="rgba(255,255,255,.105)"
          gap={26}
          size={1}
          variant={BackgroundVariant.Dots}
        />
      </ReactFlow>

      <header className="workspace-header">
        <div className="workspace-project">
          <Link aria-label="Back to projects" className="canvas-back" href="/">
            <ArrowLeftIcon size={18} />
          </Link>
          <span className="brand-mark canvas-brand">
            <BranchIcon size={17} />
          </span>
          <div>
            <h1>{detail.project.title}</h1>
            <p>
              {generatedCount} generated
              {inProgressCount > 0 ? ` · ${inProgressCount} in progress` : ""}
              {failedAttemptCount > 0
                ? ` · ${failedAttemptCount} failed`
                : ""}{" "}
              · {detail.revisions.length}{" "}
              {detail.revisions.length === 1 ? "revision" : "revisions"}
            </p>
          </div>
        </div>
        <div className="workspace-actions">
          <span className={`save-state ${savingPositions ? "is-saving" : ""}`}>
            {savingPositions
              ? "Saving position…"
              : inProgressCount > 0
                ? "Live generation"
                : "Saved locally"}
          </span>
          <button
            className="canvas-action-button"
            disabled={layouting || !nodes.length}
            onClick={() => void autoLayout()}
            type="button"
          >
            <LayoutIcon size={17} />
            {layouting ? "Arranging…" : "Auto layout"}
          </button>
        </div>
      </header>

      <div className="canvas-controls" aria-label="Canvas controls">
        <button
          aria-label="Zoom in"
          onClick={() => void instance?.zoomIn({ duration: 180 })}
          type="button"
        >
          <ZoomInIcon size={18} />
        </button>
        <button
          aria-label="Zoom out"
          onClick={() => void instance?.zoomOut({ duration: 180 })}
          type="button"
        >
          <ZoomOutIcon size={18} />
        </button>
        <button
          aria-label="Fit graph to view"
          onClick={() =>
            void instance?.fitView({
              padding: 0.2,
              duration: 450,
              maxZoom: 1.15,
            })
          }
          type="button"
        >
          <FitIcon size={18} />
        </button>
      </div>

      {!nodes.length ? (
        <div className="empty-canvas">
          <span className="empty-canvas-orbit">
            <i />
          </span>
          <h2>
            {hasActiveJob
              ? "The first paths are taking shape"
              : "No generated images yet"}
          </h2>
          <p>
            {hasActiveJob
              ? "Planning, generating, and evaluating the first revision. Images will appear here as they finish."
              : "Refresh to check for new images, or return to the project list."}
          </p>
          {!hasActiveJob ? (
            <button
              className="quiet-button"
              onClick={() => void loadProject(true)}
              type="button"
            >
              <RefreshIcon size={16} />
              Refresh canvas
            </button>
          ) : null}
        </div>
      ) : null}

      {selectedImageForExplore && !inspectorOpen ? (
        <button
          className="floating-explore"
          onClick={() => {
            setSelection({ kind: "image", id: selectedImageForExplore.id });
            window.setTimeout(
              () => useWorkspaceStore.getState().openExplore(),
              0,
            );
          }}
          type="button"
        >
          <SparklesIcon size={17} />
          Explore this image
        </button>
      ) : null}

      <JobStatus jobs={detail.jobs} onRefresh={() => void loadProject(true)} />
      <Inspector
        detail={detail}
        onReferencesUploaded={onReferencesUploaded}
        onStarted={() => loadProject(true)}
      />
      {notice ? (
        <div className="canvas-toast" role="status">
          {notice}
          <button
            aria-label="Dismiss"
            onClick={() => setNotice(null)}
            type="button"
          >
            ×
          </button>
        </div>
      ) : null}
    </main>
  );
}
