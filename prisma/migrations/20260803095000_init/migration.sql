-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "originalPrompt" TEXT NOT NULL,
    "variantsPerRevision" INTEGER NOT NULL DEFAULT 4,
    "optimizationRounds" INTEGER NOT NULL DEFAULT 3,
    "survivorsPerRound" INTEGER NOT NULL DEFAULT 2,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastOpenedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Revision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "parentRevisionId" TEXT,
    "sourceImageId" TEXT,
    "round" INTEGER NOT NULL,
    "branchIndex" INTEGER NOT NULL,
    "originalPrompt" TEXT NOT NULL,
    "editPrompt" TEXT,
    "planningPrompt" TEXT NOT NULL,
    "expandedPrompt" TEXT NOT NULL,
    "optimizationSummary" TEXT,
    "jobLogPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Revision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Revision_parentRevisionId_fkey" FOREIGN KEY ("parentRevisionId") REFERENCES "Revision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Revision_sourceImageId_fkey" FOREIGN KEY ("sourceImageId") REFERENCES "GeneratedImage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GeneratedImage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "candidateIndex" INTEGER NOT NULL,
    "filePath" TEXT NOT NULL,
    "thumbnailPath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "generationPrompt" TEXT NOT NULL,
    "generationMeta" TEXT NOT NULL,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GeneratedImage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GeneratedImage_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "Revision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imageId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "strengthsJson" TEXT NOT NULL,
    "weaknessesJson" TEXT NOT NULL,
    "recommendationsJson" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "evaluatorPrompt" TEXT NOT NULL,
    "evaluatorResponse" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Evaluation_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "GeneratedImage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReferenceAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferenceAsset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RevisionReference" (
    "revisionId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "role" TEXT NOT NULL,

    PRIMARY KEY ("revisionId", "referenceId"),
    CONSTRAINT "RevisionReference_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "Revision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RevisionReference_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "ReferenceAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CreativeEdge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "sourceImageId" TEXT NOT NULL,
    "targetImageId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreativeEdge_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CreativeEdge_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "Revision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CreativeEdge_sourceImageId_fkey" FOREIGN KEY ("sourceImageId") REFERENCES "GeneratedImage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CreativeEdge_targetImageId_fkey" FOREIGN KEY ("targetImageId") REFERENCES "GeneratedImage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CanvasPosition" (
    "imageId" TEXT NOT NULL PRIMARY KEY,
    "x" REAL NOT NULL,
    "y" REAL NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CanvasPosition_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "GeneratedImage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "payloadJson" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "currentRound" INTEGER NOT NULL DEFAULT 0,
    "totalRounds" INTEGER NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CandidateAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "branchIndex" INTEGER NOT NULL,
    "candidateIndex" INTEGER NOT NULL,
    "parentImageId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "prompt" TEXT NOT NULL,
    "outputPath" TEXT,
    "error" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CandidateAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Revision_projectId_round_idx" ON "Revision"("projectId", "round");

-- CreateIndex
CREATE INDEX "Revision_parentRevisionId_idx" ON "Revision"("parentRevisionId");

-- CreateIndex
CREATE INDEX "Revision_sourceImageId_idx" ON "Revision"("sourceImageId");

-- CreateIndex
CREATE INDEX "GeneratedImage_projectId_idx" ON "GeneratedImage"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedImage_revisionId_candidateIndex_key" ON "GeneratedImage"("revisionId", "candidateIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Evaluation_imageId_key" ON "Evaluation"("imageId");

-- CreateIndex
CREATE INDEX "ReferenceAsset_projectId_idx" ON "ReferenceAsset"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "RevisionReference_revisionId_ordinal_key" ON "RevisionReference"("revisionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "CreativeEdge_targetImageId_key" ON "CreativeEdge"("targetImageId");

-- CreateIndex
CREATE INDEX "CreativeEdge_projectId_idx" ON "CreativeEdge"("projectId");

-- CreateIndex
CREATE INDEX "CreativeEdge_sourceImageId_idx" ON "CreativeEdge"("sourceImageId");

-- CreateIndex
CREATE INDEX "Job_state_createdAt_idx" ON "Job"("state", "createdAt");

-- CreateIndex
CREATE INDEX "Job_projectId_createdAt_idx" ON "Job"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "JobEvent_jobId_createdAt_idx" ON "JobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "CandidateAttempt_jobId_state_idx" ON "CandidateAttempt"("jobId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "CandidateAttempt_jobId_round_branchIndex_candidateIndex_key" ON "CandidateAttempt"("jobId", "round", "branchIndex", "candidateIndex");
