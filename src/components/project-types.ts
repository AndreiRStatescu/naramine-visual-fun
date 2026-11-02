import type { Edge, Node, XYPosition } from "@xyflow/react";

export type EvaluationRecord = {
  id?: string;
  score: number | null;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  reasoning: string;
  evaluatorPrompt?: string;
  evaluatorResponse?: string;
  createdAt?: string;
};

export type ReferenceRecord = {
  id: string;
  originalName: string;
  mimeType?: string;
  width?: number;
  height?: number;
  createdAt?: string;
  url?: string;
};

export type RevisionReferenceRecord = {
  referenceId: string;
  ordinal: number;
  role?: string;
  reference?: ReferenceRecord;
};

export type RevisionRecord = {
  id: string;
  parentRevisionId?: string | null;
  sourceImageId?: string | null;
  round: number;
  branchIndex: number;
  originalPrompt: string;
  editPrompt?: string | null;
  planningPrompt?: string;
  expandedPrompt?: string;
  optimizationSummary?: string | null;
  jobLogPath?: string | null;
  createdAt?: string;
  references: RevisionReferenceRecord[];
};

export type ImageRecord = {
  id: string;
  revisionId: string;
  candidateIndex: number;
  round?: number;
  branchIndex?: number;
  provisional: boolean;
  originalUrl?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  selected?: boolean;
  generationPrompt?: string;
  generationMeta?: string;
  createdAt?: string;
  status?: string;
  error?: string | null;
  position?: XYPosition | null;
  evaluation?: EvaluationRecord | null;
  revision?: RevisionRecord;
};

export type CreativeEdgeRecord = {
  id: string;
  sourceImageId: string;
  targetImageId: string;
  revisionId?: string;
  label: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  revision?: RevisionRecord;
};

export type JobEventRecord = {
  id: string;
  level?: string;
  kind?: string;
  message: string;
  createdAt?: string;
};

export type JobRecord = {
  id: string;
  type?: string;
  state: string;
  progress: number;
  currentRound: number;
  totalRounds: number;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
  events: JobEventRecord[];
};

export type ProjectRecord = {
  id: string;
  title: string;
  originalPrompt: string;
  variantsPerRevision: number;
  optimizationRounds: number;
  survivorsPerRound: number;
  createdAt?: string;
  updatedAt?: string;
  lastOpenedAt?: string;
};

export type ProjectDetail = {
  project: ProjectRecord;
  images: ImageRecord[];
  edges: CreativeEdgeRecord[];
  revisions: RevisionRecord[];
  references: ReferenceRecord[];
  jobs: JobRecord[];
};

export type ImageNodeData = {
  image: ImageRecord;
  imageUrl: string;
  label: string;
  [key: string]: unknown;
};

export type ImageFlowNode = Node<ImageNodeData, "image">;
export type CreativeFlowEdge = Edge<{ edge: CreativeEdgeRecord }>;

type AnyRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): AnyRecord => (isRecord(value) ? value : {});
const asString = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;
const asNumber = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const asBoolean = (value: unknown, fallback = false) =>
  typeof value === "boolean" ? value : fallback;
const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

export function parseStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function parseMetadata(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeEvaluation(value: unknown): EvaluationRecord | null {
  if (!value) return null;
  const raw = asRecord(value);
  const rawScore = raw.score;
  return {
    id: asString(raw.id) || undefined,
    score:
      typeof rawScore === "number" && Number.isFinite(rawScore)
        ? rawScore
        : null,
    strengths: parseStringList(raw.strengths ?? raw.strengthsJson),
    weaknesses: parseStringList(raw.weaknesses ?? raw.weaknessesJson),
    recommendations: parseStringList(
      raw.recommendations ??
        raw.recommendedImprovements ??
        raw.recommendationsJson,
    ),
    reasoning: asString(raw.reasoning),
    evaluatorPrompt: asString(raw.evaluatorPrompt) || undefined,
    evaluatorResponse: asString(raw.evaluatorResponse) || undefined,
    createdAt: asString(raw.createdAt) || undefined,
  };
}

function normalizeReference(value: unknown): ReferenceRecord | null {
  const raw = asRecord(value);
  const id = asString(raw.id ?? raw.referenceId);
  if (!id) return null;
  return {
    id,
    originalName: asString(raw.originalName ?? raw.name, "Reference image"),
    mimeType: asString(raw.mimeType) || undefined,
    width: asNumber(raw.width) || undefined,
    height: asNumber(raw.height) || undefined,
    createdAt: asString(raw.createdAt) || undefined,
    url: asString(raw.url ?? raw.imageUrl ?? raw.thumbnailUrl) || undefined,
  };
}

function normalizeRevisionReference(
  value: unknown,
  index: number,
): RevisionReferenceRecord | null {
  const raw = asRecord(value);
  const reference = normalizeReference(raw.reference ?? raw);
  const referenceId =
    asString(raw.referenceId ?? raw.id) || reference?.id || "";
  if (!referenceId) return null;
  return {
    referenceId,
    ordinal: asNumber(raw.ordinal, index),
    role: asString(raw.role) || undefined,
    reference: reference ?? undefined,
  };
}

function normalizeRevision(value: unknown): RevisionRecord | null {
  const raw = asRecord(value);
  const id = asString(raw.id ?? raw.revisionId);
  if (!id) return null;
  return {
    id,
    parentRevisionId: asString(raw.parentRevisionId) || null,
    sourceImageId: asString(raw.sourceImageId) || null,
    round: asNumber(raw.round),
    branchIndex: asNumber(raw.branchIndex),
    originalPrompt: asString(raw.originalPrompt),
    editPrompt: asString(raw.editPrompt) || null,
    planningPrompt: asString(raw.planningPrompt) || undefined,
    expandedPrompt: asString(raw.expandedPrompt) || undefined,
    optimizationSummary: asString(raw.optimizationSummary) || null,
    jobLogPath: asString(raw.jobLogPath) || null,
    createdAt: asString(raw.createdAt) || undefined,
    references: asArray(raw.references)
      .map(normalizeRevisionReference)
      .filter((item): item is RevisionReferenceRecord => Boolean(item))
      .sort((left, right) => left.ordinal - right.ordinal),
  };
}

function readPosition(value: unknown): XYPosition | null {
  const raw = asRecord(value);
  const x = raw.x;
  const y = raw.y;
  return typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y)
    ? { x, y }
    : null;
}

function normalizeImage(
  value: unknown,
  revisions: Map<string, RevisionRecord>,
): ImageRecord | null {
  const outer = asRecord(value);
  const nodeData = asRecord(outer.data);
  const raw = asRecord(nodeData.image ?? outer.image ?? value);
  const id = asString(raw.id ?? raw.imageId ?? outer.id);
  if (!id) return null;
  const revisionId = asString(raw.revisionId ?? nodeData.revisionId);
  const inlineRevision = normalizeRevision(raw.revision ?? nodeData.revision);
  const revision = inlineRevision ?? revisions.get(revisionId);
  const rawStatus = asString(raw.status ?? nodeData.status);
  const provisional = asBoolean(raw.provisional ?? nodeData.provisional);
  const evaluation = normalizeEvaluation(raw.evaluation ?? nodeData.evaluation);
  const originalUrl = asString(raw.originalUrl ?? nodeData.originalUrl);
  const thumbnailUrl = asString(raw.thumbnailUrl ?? nodeData.thumbnailUrl);
  return {
    id,
    revisionId: revisionId || revision?.id || "",
    candidateIndex: asNumber(raw.candidateIndex ?? nodeData.candidateIndex),
    round:
      asNumber(raw.round ?? nodeData.round, revision?.round ?? 0) || undefined,
    branchIndex: asNumber(
      raw.branchIndex ?? nodeData.branchIndex,
      revision?.branchIndex ?? 0,
    ),
    provisional,
    originalUrl: originalUrl || undefined,
    thumbnailUrl: thumbnailUrl || undefined,
    width: asNumber(raw.width) || undefined,
    height: asNumber(raw.height) || undefined,
    selected: asBoolean(raw.selected),
    generationPrompt:
      asString(raw.generationPrompt ?? nodeData.generationPrompt) || undefined,
    generationMeta:
      asString(raw.generationMeta ?? nodeData.generationMeta) || undefined,
    createdAt: asString(raw.createdAt) || undefined,
    status:
      rawStatus ||
      (provisional
        ? "RUNNING"
        : originalUrl ||
            thumbnailUrl ||
            raw.thumbnailPath ||
            raw.filePath ||
            evaluation
          ? "COMPLETED"
          : "RUNNING"),
    error: asString(raw.error ?? nodeData.error) || null,
    position:
      readPosition(raw.position) ??
      readPosition(outer.position) ??
      readPosition(nodeData.position),
    evaluation,
    revision,
  };
}

function normalizeEdge(
  value: unknown,
  revisions: Map<string, RevisionRecord>,
): CreativeEdgeRecord | null {
  const outer = asRecord(value);
  const data = asRecord(outer.data);
  const raw = asRecord(data.edge ?? outer.edge ?? value);
  const id = asString(raw.id ?? outer.id);
  const sourceImageId = asString(
    raw.sourceImageId ?? raw.source ?? outer.source,
  );
  const targetImageId = asString(
    raw.targetImageId ?? raw.target ?? outer.target,
  );
  if (!id || !sourceImageId || !targetImageId) return null;
  const revisionId = asString(raw.revisionId);
  return {
    id,
    sourceImageId,
    targetImageId,
    revisionId: revisionId || undefined,
    label: asString(raw.label ?? outer.label, "Explored from"),
    metadata: parseMetadata(raw.metadata ?? raw.metadataJson ?? data.metadata),
    createdAt: asString(raw.createdAt) || undefined,
    revision:
      normalizeRevision(raw.revision ?? data.revision) ??
      revisions.get(revisionId),
  };
}

function normalizeJobEvent(value: unknown): JobEventRecord | null {
  const raw = asRecord(value);
  const id = asString(raw.id);
  const message = asString(raw.message);
  if (!id && !message) return null;
  return {
    id: id || `${asString(raw.createdAt)}-${message}`,
    level: asString(raw.level) || undefined,
    kind: asString(raw.kind) || undefined,
    message,
    createdAt: asString(raw.createdAt) || undefined,
  };
}

function normalizeJob(value: unknown): JobRecord | null {
  const raw = asRecord(value);
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    type: asString(raw.type) || undefined,
    state: asString(raw.state, "QUEUED").toUpperCase(),
    progress: asNumber(raw.progress),
    currentRound: asNumber(raw.currentRound),
    totalRounds: asNumber(raw.totalRounds),
    error: asString(raw.error) || null,
    createdAt: asString(raw.createdAt) || undefined,
    updatedAt: asString(raw.updatedAt) || undefined,
    events: asArray(raw.events)
      .map(normalizeJobEvent)
      .filter((item): item is JobEventRecord => Boolean(item)),
  };
}

export function normalizeProjectDetail(payload: unknown): ProjectDetail {
  const envelope = asRecord(payload);
  const projectRaw = asRecord(envelope.project ?? envelope.data ?? payload);
  const graph = asRecord(envelope.graph ?? projectRaw.graph);

  const revisionValues = [
    ...asArray(envelope.revisions),
    ...asArray(projectRaw.revisions),
  ];
  const revisions = Array.from(
    new Map(
      revisionValues
        .map(normalizeRevision)
        .filter((item): item is RevisionRecord => Boolean(item))
        .map((item) => [item.id, item]),
    ).values(),
  );
  const revisionMap = new Map(
    revisions.map((revision) => [revision.id, revision]),
  );

  const imageValues =
    asArray(graph.nodes).length > 0
      ? asArray(graph.nodes)
      : asArray(envelope.images).length > 0
        ? asArray(envelope.images)
        : asArray(projectRaw.images);
  const images = imageValues
    .map((value) => normalizeImage(value, revisionMap))
    .filter((item): item is ImageRecord => Boolean(item));

  const edgeValues =
    asArray(graph.edges).length > 0
      ? asArray(graph.edges)
      : asArray(envelope.edges).length > 0
        ? asArray(envelope.edges)
        : asArray(projectRaw.edges);
  const edges = edgeValues
    .map((value) => normalizeEdge(value, revisionMap))
    .filter((item): item is CreativeEdgeRecord => Boolean(item));

  const references = [
    ...asArray(envelope.references),
    ...asArray(projectRaw.references),
  ]
    .map(normalizeReference)
    .filter((item): item is ReferenceRecord => Boolean(item));

  const jobs = [...asArray(envelope.jobs), ...asArray(projectRaw.jobs)]
    .map(normalizeJob)
    .filter((item): item is JobRecord => Boolean(item))
    .sort((left, right) =>
      asString(right.createdAt).localeCompare(asString(left.createdAt)),
    );

  return {
    project: {
      id: asString(projectRaw.id),
      title: asString(projectRaw.title, "Untitled exploration"),
      originalPrompt: asString(projectRaw.originalPrompt),
      variantsPerRevision: asNumber(projectRaw.variantsPerRevision, 4),
      optimizationRounds: asNumber(projectRaw.optimizationRounds, 3),
      survivorsPerRound: asNumber(projectRaw.survivorsPerRound, 2),
      createdAt: asString(projectRaw.createdAt) || undefined,
      updatedAt: asString(projectRaw.updatedAt) || undefined,
      lastOpenedAt: asString(projectRaw.lastOpenedAt) || undefined,
    },
    images,
    edges,
    revisions,
    references: Array.from(
      new Map(
        references.map((reference) => [reference.id, reference]),
      ).values(),
    ),
    jobs,
  };
}

export function extractProjects(payload: unknown): ProjectRecord[] {
  const raw = asRecord(payload);
  const values = Array.isArray(payload)
    ? payload
    : asArray(raw.projects).length > 0
      ? asArray(raw.projects)
      : asArray(raw.data);
  return values.flatMap((value): ProjectRecord[] => {
    const item = asRecord(value);
    const id = asString(item.id);
    if (!id) return [];
    return [
      {
        id,
        title: asString(item.title, "Untitled exploration"),
        originalPrompt: asString(item.originalPrompt),
        variantsPerRevision: asNumber(item.variantsPerRevision, 4),
        optimizationRounds: asNumber(item.optimizationRounds, 3),
        survivorsPerRound: asNumber(item.survivorsPerRound, 2),
        createdAt: asString(item.createdAt) || undefined,
        updatedAt: asString(item.updatedAt) || undefined,
        lastOpenedAt: asString(item.lastOpenedAt) || undefined,
      },
    ];
  });
}

export async function readApiJson(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const raw = asRecord(body);
    const nested = asRecord(raw.error);
    throw new Error(
      asString(raw.message ?? nested.message ?? raw.error) ||
        `Request failed (${response.status})`,
    );
  }
  return body;
}

export function readCreatedProjectId(payload: unknown): string {
  const raw = asRecord(payload);
  const project = asRecord(raw.project ?? raw.data);
  return asString(project.id ?? raw.id ?? raw.projectId);
}

export function readUploadedReferences(payload: unknown): ReferenceRecord[] {
  const raw = asRecord(payload);
  const values = Array.isArray(payload)
    ? payload
    : asArray(raw.references).length > 0
      ? asArray(raw.references)
      : raw.reference
        ? [raw.reference]
        : raw.data
          ? Array.isArray(raw.data)
            ? raw.data
            : [raw.data]
          : [];
  return values
    .map(normalizeReference)
    .filter((item): item is ReferenceRecord => Boolean(item));
}
