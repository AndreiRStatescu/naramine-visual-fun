"use client";

import { Handle, NodeProps, Position } from "@xyflow/react";
import { useState } from "react";

import { ImageIcon } from "@/components/icons";
import type { ImageFlowNode } from "@/components/project-types";

export function ImageNode({ data, selected }: NodeProps<ImageFlowNode>) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const state = (data.image.status ?? "COMPLETED").toUpperCase();
  const errored = ["FAILED", "ERROR"].includes(state);
  const hasPreview = Boolean(data.image.thumbnailUrl || data.image.originalUrl);
  const waiting = !errored && !hasPreview;
  const evaluating =
    hasPreview && data.image.provisional && state === "EVALUATING";

  return (
    <article
      aria-label={`${data.label}${waiting ? ", generating" : ""}`}
      className={`image-node ${selected ? "is-selected" : ""} ${waiting ? "is-waiting" : ""} ${errored ? "is-error" : ""}`}
    >
      <Handle
        className="image-node-handle"
        position={Position.Left}
        type="target"
      />
      <div className="image-node-frame">
        {hasPreview && !previewFailed && !errored ? (
          // Generated files are served by the local image route and have no remote host.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            alt={data.label}
            draggable={false}
            onError={() => setPreviewFailed(true)}
            src={
              data.image.thumbnailUrl ?? data.image.originalUrl ?? data.imageUrl
            }
          />
        ) : null}
        {evaluating ? (
          <span className="image-node-stage">Evaluating</span>
        ) : null}
        {waiting ? (
          <div
            className="image-node-pending"
            aria-label="Image generation in progress"
          >
            <span className="image-shimmer" />
            <span className="generation-orbit">
              <i />
            </span>
          </div>
        ) : null}
        {(previewFailed || errored) && !waiting ? (
          <div className="image-node-fallback">
            <ImageIcon size={25} />
            <span>{errored ? "Generation failed" : "Preview unavailable"}</span>
          </div>
        ) : null}
      </div>
      <Handle
        className="image-node-handle"
        position={Position.Right}
        type="source"
      />
    </article>
  );
}
