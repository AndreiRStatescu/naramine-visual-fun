"use client";

import { CSSProperties, ReactNode, useMemo, useState } from "react";

import {
  CloseIcon,
  ErrorIcon,
  ImageIcon,
  SparklesIcon,
} from "@/components/icons";
import type {
  CreativeEdgeRecord,
  ImageRecord,
  ProjectDetail,
  ReferenceRecord,
  RevisionRecord,
} from "@/components/project-types";
import { useWorkspaceStore } from "@/store/workspace-store";

import { ExploreForm } from "./explore-form";

const formatDate = (value?: string) => {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

function TabStrip({
  active,
  onChange,
  tabs,
}: {
  active: string;
  onChange: (tab: string) => void;
  tabs: { id: string; label: string }[];
}) {
  return (
    <div className="inspector-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          aria-selected={active === tab.id}
          className={active === tab.id ? "is-active" : ""}
          key={tab.id}
          onClick={() => onChange(tab.id)}
          role="tab"
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="inspector-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function PromptBlock({
  children,
  muted = false,
}: {
  children?: string | null;
  muted?: boolean;
}) {
  return children ? (
    <p className={`prompt-block ${muted ? "is-muted" : ""}`}>{children}</p>
  ) : (
    <p className="empty-copy">Not recorded for this revision.</p>
  );
}

function ListBlock({ values, empty }: { values: string[]; empty: string }) {
  return values.length ? (
    <ul className="evaluation-list">
      {values.map((value, index) => (
        <li key={`${value}-${index}`}>{value}</li>
      ))}
    </ul>
  ) : (
    <p className="empty-copy">{empty}</p>
  );
}

function ImageDetails({
  image,
  project,
}: {
  image: ImageRecord;
  project: ProjectDetail["project"];
}) {
  const revision = image.revision;
  return (
    <div className="inspector-scroll-content">
      <Section title="Original brief">
        <PromptBlock>
          {revision?.originalPrompt || project.originalPrompt}
        </PromptBlock>
      </Section>
      {revision?.editPrompt ? (
        <Section title="Edit direction">
          <PromptBlock>{revision.editPrompt}</PromptBlock>
        </Section>
      ) : null}
      <Section title="Expanded prompt">
        <PromptBlock muted>
          {revision?.expandedPrompt || image.generationPrompt}
        </PromptBlock>
      </Section>
      <Section title="Generation">
        <dl className="metadata-grid">
          <div>
            <dt>Round</dt>
            <dd>{revision?.round || image.round || 1}</dd>
          </div>
          <div>
            <dt>Candidate</dt>
            <dd>{image.candidateIndex + 1}</dd>
          </div>
          <div>
            <dt>Dimensions</dt>
            <dd>
              {image.width && image.height
                ? `${image.width} × ${image.height}`
                : "—"}
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(image.createdAt)}</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}

function EvaluationDetails({ image }: { image: ImageRecord }) {
  const evaluation = image.evaluation;
  const failed = ["FAILED", "ERROR"].includes(
    (image.status ?? "").toUpperCase(),
  );
  if (!evaluation)
    return (
      <div className="inspector-empty-tab">
        {failed ? <ErrorIcon size={24} /> : <span className="empty-ring" />}
        <h3>{failed ? "Evaluation unavailable" : "Evaluation pending"}</h3>
        <p>
          {failed
            ? "This candidate failed before an evaluation could be recorded."
            : "The score and critique will appear as soon as this candidate has been reviewed."}
        </p>
      </div>
    );
  const score = evaluation.score ?? 0;
  return (
    <div className="inspector-scroll-content">
      <div className="score-hero">
        <div
          className="score-ring"
          style={
            {
              "--score": `${Math.max(0, Math.min(100, score)) * 3.6}deg`,
            } as CSSProperties
          }
        >
          <strong>{evaluation.score ?? "—"}</strong>
          <span>/ 100</span>
        </div>
        <div>
          <span>Prompt alignment</span>
          <p>{evaluation.reasoning || "No concise reasoning was recorded."}</p>
        </div>
      </div>
      <Section title="Strengths">
        <ListBlock
          empty="No strengths recorded."
          values={evaluation.strengths}
        />
      </Section>
      <Section title="Weaknesses">
        <ListBlock
          empty="No weaknesses recorded."
          values={evaluation.weaknesses}
        />
      </Section>
      <Section title="Recommended next moves">
        <ListBlock
          empty="No recommendations recorded."
          values={evaluation.recommendations}
        />
      </Section>
    </div>
  );
}

function HistoryDetails({
  detail,
  image,
}: {
  detail: ProjectDetail;
  image: ImageRecord;
}) {
  const path = useMemo(() => {
    const imagesById = new Map(detail.images.map((item) => [item.id, item]));
    const incoming = new Map(
      detail.edges.map((edge) => [edge.targetImageId, edge]),
    );
    const result: ImageRecord[] = [];
    const seen = new Set<string>();
    let current: ImageRecord | undefined = image;
    while (current && !seen.has(current.id)) {
      result.unshift(current);
      seen.add(current.id);
      const edge = incoming.get(current.id);
      current = edge ? imagesById.get(edge.sourceImageId) : undefined;
    }
    return result;
  }, [detail.edges, detail.images, image]);

  return (
    <div className="inspector-scroll-content">
      <div className="history-summary">
        <strong>{path.length}</strong>
        <span>
          {path.length === 1
            ? "revision on this path"
            : "revisions on this path"}
        </span>
      </div>
      <ol className="history-path">
        {path.map((item, index) => (
          <li
            className={item.id === image.id ? "is-current" : ""}
            key={item.id}
          >
            <span className="history-marker">{index + 1}</span>
            <div>
              <div>
                <strong>
                  {item.provisional
                    ? ["FAILED", "ERROR"].includes(
                        (item.status ?? "").toUpperCase(),
                      )
                      ? "Failed candidate"
                      : "Candidate in progress"
                    : index === 0
                      ? "Initial generation"
                      : item.revision?.editPrompt || "Optimized variation"}
                </strong>
                {item.id === image.id ? <em>Current</em> : null}
              </div>
              <p>
                Round {item.revision?.round || item.round || index + 1} ·
                Candidate {item.candidateIndex + 1} ·{" "}
                {formatDate(item.createdAt)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReferenceDetails({
  detail,
  revision,
}: {
  detail: ProjectDetail;
  revision?: RevisionRecord;
}) {
  const references = (revision?.references ?? []).map((link) => ({
    link,
    reference:
      link.reference ??
      detail.references.find((item) => item.id === link.referenceId),
  }));
  return references.length ? (
    <div className="inspector-scroll-content reference-detail-list">
      {references.map(({ link, reference }) => (
        <article key={link.referenceId}>
          <div className="reference-detail-thumb">
            {reference?.url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img alt={reference.originalName} src={reference.url} />
            ) : (
              <ImageIcon size={23} />
            )}
          </div>
          <div>
            <strong>{reference?.originalName ?? "Reference image"}</strong>
            <span>{link.role || `Reference ${link.ordinal + 1}`}</span>
            <small>
              {reference?.width && reference.height
                ? `${reference.width} × ${reference.height}`
                : reference?.mimeType || "Image"}
            </small>
          </div>
        </article>
      ))}
    </div>
  ) : (
    <div className="inspector-empty-tab">
      <ImageIcon size={24} />
      <h3>No references</h3>
      <p>This branch was generated without additional reference images.</p>
    </div>
  );
}

function ImageInspector({
  detail,
  image,
  onReferencesUploaded,
  onStarted,
}: {
  detail: ProjectDetail;
  image: ImageRecord;
  onReferencesUploaded: (references: ReferenceRecord[]) => void;
  onStarted: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState("image");
  const closeInspector = useWorkspaceStore((state) => state.closeInspector);
  const exploreOpen = useWorkspaceStore((state) => state.exploreOpen);
  const openExplore = useWorkspaceStore((state) => state.openExplore);
  const closeExplore = useWorkspaceStore((state) => state.closeExplore);
  const imageState = (image.status ?? "COMPLETED").toUpperCase();
  const failed = ["FAILED", "ERROR"].includes(imageState);
  const provisional = image.provisional;

  if (exploreOpen) {
    return (
      <ExploreForm
        image={image}
        onBack={closeExplore}
        onReferencesUploaded={onReferencesUploaded}
        onStarted={onStarted}
        projectId={detail.project.id}
        references={detail.references}
      />
    );
  }

  return (
    <>
      <div className="inspector-header">
        <div>
          <span>
            {failed
              ? "Failed candidate"
              : provisional
                ? "Candidate in progress"
                : "Generated image"}
          </span>
          <h2>
            Round {image.revision?.round || image.round || 1} · Candidate{" "}
            {image.candidateIndex + 1}
          </h2>
        </div>
        <button
          aria-label="Close inspector"
          className="icon-button"
          onClick={closeInspector}
          type="button"
        >
          <CloseIcon size={18} />
        </button>
      </div>
      <div className="inspector-image-preview">
        {provisional ? (
          <div
            className={`inspector-generation-placeholder ${failed ? "is-failed" : ""}`}
          >
            {failed ? (
              <span className="inspector-failure-icon">
                <ErrorIcon size={24} />
              </span>
            ) : (
              <span className="generation-orbit inspector-orbit">
                <i />
              </span>
            )}
            <strong>{failed ? "Generation failed" : "Creating image"}</strong>
            <p>
              {failed
                ? image.error || "This candidate could not be completed."
                : imageState === "EVALUATING"
                  ? "Reviewing this candidate against the original brief…"
                  : "The preview will appear here as soon as the candidate is finalized."}
            </p>
          </div>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt="Selected generated candidate"
              src={image.originalUrl ?? `/api/images/${image.id}`}
            />
            {image.evaluation?.score !== null &&
            image.evaluation?.score !== undefined ? (
              <span>{image.evaluation.score}</span>
            ) : null}
          </>
        )}
      </div>
      <TabStrip
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "image", label: "Image" },
          { id: "evaluation", label: "Evaluation" },
          { id: "history", label: "History" },
          { id: "references", label: "References" },
        ]}
      />
      <div className="inspector-body">
        {tab === "image" ? (
          <ImageDetails image={image} project={detail.project} />
        ) : null}
        {tab === "evaluation" ? <EvaluationDetails image={image} /> : null}
        {tab === "history" ? (
          <HistoryDetails detail={detail} image={image} />
        ) : null}
        {tab === "references" ? (
          <ReferenceDetails detail={detail} revision={image.revision} />
        ) : null}
      </div>
      <div className="inspector-footer">
        <button
          className="primary-button branch-button"
          disabled={provisional || imageState !== "COMPLETED"}
          onClick={openExplore}
          type="button"
        >
          <SparklesIcon size={17} />
          Explore from this image
        </button>
        <p>
          {provisional
            ? failed
              ? "Failed candidates cannot start a new branch."
              : "Exploration becomes available when this image is complete."
            : "A new branch preserves this image and everything before it."}
        </p>
      </div>
    </>
  );
}

function metadataRows(metadata: Record<string, unknown>) {
  return Object.entries(metadata).filter(([, value]) =>
    ["string", "number", "boolean"].includes(typeof value),
  );
}

function EdgeInspector({
  detail,
  edge,
}: {
  detail: ProjectDetail;
  edge: CreativeEdgeRecord;
}) {
  const [tab, setTab] = useState("decision");
  const closeInspector = useWorkspaceStore((state) => state.closeInspector);
  const revision =
    edge.revision ??
    detail.revisions.find((item) => item.id === edge.revisionId);
  const metadata = edge.metadata ?? {};
  const loggedJobId = revision?.jobLogPath
    ?.split("/")
    .at(-1)
    ?.replace(/\.jsonl$/i, "");
  const metadataJobId =
    typeof metadata.jobId === "string" ? metadata.jobId : undefined;
  const scopedJobId = metadataJobId || loggedJobId;
  const matchedJob = scopedJobId
    ? detail.jobs.find((job) => job.id === scopedJobId)
    : undefined;
  const logJobs = matchedJob ? [matchedJob] : detail.jobs.slice(0, 1);
  const latestEvents = logJobs
    .flatMap((job) => job.events.map((event) => ({ ...event, job })))
    .slice(-60)
    .reverse();
  return (
    <>
      <div className="inspector-header edge-inspector-header">
        <div>
          <span>Creative decision</span>
          <h2>{edge.label}</h2>
        </div>
        <button
          aria-label="Close inspector"
          className="icon-button"
          onClick={closeInspector}
          type="button"
        >
          <CloseIcon size={18} />
        </button>
      </div>
      <div className="edge-visual">
        <span />
        <i />
        <span />
        <div>{edge.label}</div>
      </div>
      <TabStrip
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "decision", label: "Edge" },
          { id: "planner", label: "Planner" },
          { id: "optimization", label: "Optimization" },
          { id: "log", label: "Log" },
        ]}
      />
      <div className="inspector-body">
        {tab === "decision" ? (
          <div className="inspector-scroll-content">
            <Section title="Edit direction">
              <PromptBlock>
                {revision?.editPrompt || "Unprompted visual exploration"}
              </PromptBlock>
            </Section>
            <Section title="Decision metadata">
              {metadataRows(metadata).length ? (
                <dl className="edge-metadata-list">
                  {metadataRows(metadata).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                      <dd>{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="empty-copy">No additional edge metadata.</p>
              )}
            </Section>
            <Section title="Created">
              <p className="plain-copy">
                {formatDate(edge.createdAt ?? revision?.createdAt)}
              </p>
            </Section>
          </div>
        ) : null}
        {tab === "planner" ? (
          <div className="inspector-scroll-content">
            <Section title="Planner input">
              <PromptBlock muted>{revision?.planningPrompt}</PromptBlock>
            </Section>
            <Section title="Expanded output">
              <PromptBlock>{revision?.expandedPrompt}</PromptBlock>
            </Section>
          </div>
        ) : null}
        {tab === "optimization" ? (
          <div className="inspector-scroll-content">
            <Section title="Optimization summary">
              <PromptBlock>{revision?.optimizationSummary}</PromptBlock>
            </Section>
            <Section title="Revision">
              <dl className="metadata-grid">
                <div>
                  <dt>Round</dt>
                  <dd>{revision?.round || 1}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{(revision?.branchIndex ?? 0) + 1}</dd>
                </div>
              </dl>
            </Section>
          </div>
        ) : null}
        {tab === "log" ? (
          <div className="inspector-scroll-content">
            {revision?.jobLogPath ? (
              <p className="log-path">{revision.jobLogPath}</p>
            ) : null}
            {latestEvents.length ? (
              <ol className="event-log">
                {latestEvents.map((event) => (
                  <li key={`${event.job.id}-${event.id}`}>
                    <i
                      className={`level-${event.level?.toLowerCase() ?? "info"}`}
                    />
                    <div>
                      <p>{event.message}</p>
                      <span>
                        {event.kind || event.job.type} ·{" "}
                        {formatDate(event.createdAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="inspector-empty-tab">
                <span className="empty-ring" />
                <h3>No events yet</h3>
                <p>
                  Planner and worker events will be shown here while the branch
                  runs.
                </p>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

export function Inspector({
  detail,
  onReferencesUploaded,
  onStarted,
}: {
  detail: ProjectDetail;
  onReferencesUploaded: (references: ReferenceRecord[]) => void;
  onStarted: () => Promise<void> | void;
}) {
  const selection = useWorkspaceStore((state) => state.selection);
  const inspectorOpen = useWorkspaceStore((state) => state.inspectorOpen);
  if (!selection || !inspectorOpen) return null;

  const selectedImage =
    selection.kind === "image"
      ? detail.images.find((item) => item.id === selection.id)
      : undefined;
  const selectedEdge =
    selection.kind === "edge"
      ? detail.edges.find((item) => item.id === selection.id)
      : undefined;

  return (
    <aside className="inspector-panel">
      {selectedImage ? (
        <ImageInspector
          detail={detail}
          image={selectedImage}
          key={selectedImage.id}
          onReferencesUploaded={onReferencesUploaded}
          onStarted={onStarted}
        />
      ) : null}
      {selectedEdge ? (
        <EdgeInspector
          detail={detail}
          edge={selectedEdge}
          key={selectedEdge.id}
        />
      ) : null}
      {!selectedImage && !selectedEdge ? (
        <div className="inspector-empty-tab">
          <ImageIcon size={24} />
          <h3>Selection unavailable</h3>
          <p>The selected item may still be generating.</p>
        </div>
      ) : null}
    </aside>
  );
}
