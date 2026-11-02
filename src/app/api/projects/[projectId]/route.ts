import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ApiError,
  assertLocalRequest,
  readJson,
  routeError,
} from "@/app/api/_lib/http";
import { buildProvisionalGraph } from "@/app/api/_lib/provisional-graph";
import {
  serializeEvaluation,
  serializeJob,
  serializeReference,
} from "@/app/api/_lib/serializers";
import { safeJsonParse } from "@/lib/contracts";
import { db, ensureDatabaseReady } from "@/server/db";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ projectId: string }> };

const projectUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(100).optional(),
    variantsPerRevision: z.number().int().min(1).max(8).optional(),
    optimizationRounds: z.number().int().min(1).max(6).optional(),
    survivorsPerRound: z.number().int().min(1).max(4).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "No changes were supplied");

function serializeProject(project: {
  id: string;
  title: string;
  originalPrompt: string;
  variantsPerRevision: number;
  optimizationRounds: number;
  survivorsPerRound: number;
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt: Date;
}) {
  return {
    id: project.id,
    title: project.title,
    originalPrompt: project.originalPrompt,
    variantsPerRevision: project.variantsPerRevision,
    optimizationRounds: project.optimizationRounds,
    survivorsPerRound: project.survivorsPerRound,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt,
  };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    assertLocalRequest(request);
    await ensureDatabaseReady();
    const { projectId } = await context.params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      include: {
        revisions: {
          orderBy: [
            { round: "asc" },
            { branchIndex: "asc" },
            { createdAt: "asc" },
          ],
          include: {
            references: {
              orderBy: { ordinal: "asc" },
              include: { reference: true },
            },
          },
        },
        images: {
          orderBy: { createdAt: "asc" },
          include: {
            evaluation: true,
            position: true,
            revision: {
              include: {
                references: {
                  orderBy: { ordinal: "asc" },
                  include: { reference: true },
                },
              },
            },
          },
        },
        edges: { orderBy: { createdAt: "asc" } },
        references: { orderBy: { createdAt: "asc" } },
        jobs: {
          orderBy: { createdAt: "desc" },
          include: {
            events: { orderBy: { createdAt: "asc" } },
            attempts: {
              orderBy: [
                { round: "asc" },
                { branchIndex: "asc" },
                { candidateIndex: "asc" },
              ],
            },
          },
        },
      },
    });

    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    // Polling the graph must not contend with worker writes every few seconds.
    // Touch project recency only when the persisted value is meaningfully stale.
    const openedProject =
      Date.now() - project.lastOpenedAt.getTime() >= 60_000
        ? await db.project.update({
            where: { id: projectId },
            data: { lastOpenedAt: new Date() },
          })
        : project;

    const revisions = project.revisions.map((revision) => ({
      id: revision.id,
      parentRevisionId: revision.parentRevisionId,
      sourceImageId: revision.sourceImageId,
      round: revision.round,
      branchIndex: revision.branchIndex,
      originalPrompt: revision.originalPrompt,
      editPrompt: revision.editPrompt,
      planningPrompt: revision.planningPrompt,
      expandedPrompt: revision.expandedPrompt,
      optimizationSummary: revision.optimizationSummary,
      jobLogPath: revision.jobLogPath,
      createdAt: revision.createdAt,
      references: revision.references.map(({ ordinal, role, reference }) => ({
        referenceId: reference.id,
        ordinal,
        role,
        reference: serializeReference(reference),
      })),
    }));

    const immutableNodes = project.images.map((image) => ({
      id: image.id,
      revisionId: image.revisionId,
      candidateIndex: image.candidateIndex,
      originalUrl: `/api/images/${encodeURIComponent(image.id)}`,
      thumbnailUrl: `/api/images/${encodeURIComponent(image.id)}?thumbnail=1`,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      sha256: image.sha256,
      selected: image.selected,
      status: "COMPLETED",
      generationPrompt: image.generationPrompt,
      generationMeta: image.generationMeta,
      generationMetadata: safeJsonParse<Record<string, unknown>>(
        image.generationMeta,
        {},
      ),
      createdAt: image.createdAt,
      position: image.position
        ? { x: image.position.x, y: image.position.y }
        : null,
      evaluation: serializeEvaluation(image.evaluation),
      revision: {
        id: image.revision.id,
        parentRevisionId: image.revision.parentRevisionId,
        sourceImageId: image.revision.sourceImageId,
        round: image.revision.round,
        branchIndex: image.revision.branchIndex,
        originalPrompt: image.revision.originalPrompt,
        editPrompt: image.revision.editPrompt,
        planningPrompt: image.revision.planningPrompt,
        expandedPrompt: image.revision.expandedPrompt,
        optimizationSummary: image.revision.optimizationSummary,
        jobLogPath: image.revision.jobLogPath,
        createdAt: image.revision.createdAt,
        references: image.revision.references.map(
          ({ ordinal, role, reference }) => ({
            referenceId: reference.id,
            ordinal,
            role,
            reference: serializeReference(reference),
          }),
        ),
      },
    }));
    const immutableEdges = project.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceImageId,
      target: edge.targetImageId,
      label: edge.label,
      metadata: safeJsonParse<Record<string, unknown>>(edge.metadataJson, {}),
      revisionId: edge.revisionId,
      createdAt: edge.createdAt,
    }));
    const provisionalGraph = buildProvisionalGraph({
      projectPrompt: project.originalPrompt,
      images: project.images,
      edges: project.edges,
      references: project.references,
      jobs: project.jobs,
    });
    const immutableRevisionsById = new Map(
      revisions.map((revision) => [revision.id, revision]),
    );
    const provisionalNodes = provisionalGraph.nodes.map((node) => ({
      ...node,
      revision:
        immutableRevisionsById.get(String(node.revisionId)) ?? node.revision,
    }));
    const provisionalRevisions = provisionalGraph.revisions.filter(
      (revision) => !immutableRevisionsById.has(String(revision.id)),
    );

    return NextResponse.json({
      project: serializeProject(openedProject),
      graph: {
        nodes: [...immutableNodes, ...provisionalNodes],
        edges: [...immutableEdges, ...provisionalGraph.edges],
      },
      revisions: [...revisions, ...provisionalRevisions],
      references: project.references.map(serializeReference),
      jobs: project.jobs.map(serializeJob),
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    await ensureDatabaseReady();
    const { projectId } = await context.params;
    const changes = projectUpdateSchema.parse(await readJson(request));
    const existing = await db.project.findUnique({ where: { id: projectId } });
    if (!existing) throw new ApiError(404, "Project not found", "NOT_FOUND");

    const variants =
      changes.variantsPerRevision ?? existing.variantsPerRevision;
    const survivors = changes.survivorsPerRound ?? existing.survivorsPerRound;
    if (survivors > variants) {
      throw new ApiError(400, "Survivors cannot exceed variants per revision");
    }

    const project = await db.project.update({
      where: { id: projectId },
      data: changes,
    });
    return NextResponse.json({ project: serializeProject(project) });
  } catch (error) {
    return routeError(error);
  }
}
