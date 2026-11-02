# Image Exploration Version Control System (IEVCS)

## Technical Architecture & Implementation Specification

> **Purpose**
>
> This document is a complete implementation specification for a
> local-first internal application that explores image generations using
> the Codex CLI and GPT Image, preserving the full history of creative
> exploration as a directed acyclic graph (DAG). It is intended for an
> engineer who has **not** seen any previous discussions.

------------------------------------------------------------------------

# 1. Product Vision

The application is **not** an image editor.

It is an **image exploration version control system**.

The user starts from a prompt, explores multiple candidate images,
iteratively refines promising candidates, and preserves the entire
creative history.

Every edit creates new revisions.

Nothing is overwritten.

The final outcome is one or more candidate leaves that the human may
continue exploring or consider final.

------------------------------------------------------------------------

# 2. Scope

## In Scope

-   Local-first application
-   Single user
-   Internal engineering tool
-   Uses **Codex CLI only**
-   Uses the user's ChatGPT subscription (no OpenAI API billing)
-   Infinite graph canvas
-   Project management
-   Automatic prompt planning
-   Automatic image evaluation
-   Multi-variant optimization
-   Revision history
-   Persistent local storage

## Out of Scope

-   Authentication
-   Multi-user collaboration
-   Cloud sync
-   Multiple image generators
-   Commercial SaaS features

------------------------------------------------------------------------

# 3. Core Concept

The fundamental object is a **Revision**.

A Revision records:

-   parent revision
-   generated images
-   planning prompt
-   evaluation
-   selected survivors
-   references
-   metadata

The entire project is represented as a DAG.

------------------------------------------------------------------------

# 4. Technology Stack

-   Next.js (App Router)
-   React
-   React Flow
-   ELK (automatic graph layout)
-   Tailwind CSS
-   Zustand
-   Prisma
-   SQLite
-   Sharp
-   Chokidar
-   Zod
-   Pino
-   Node child_process for Codex CLI
-   Docker Compose
-   Makefile

No Redis.

No Celery.

No RabbitMQ.

No PostgreSQL.

------------------------------------------------------------------------

# 5. Architecture

Single Next.js application.

Responsibilities:

Frontend - React Flow canvas - Project browser - Inspector - Settings -
Job monitoring

Backend (Next.js Route Handlers / Server Actions) - Project CRUD -
Revision creation - Codex orchestration - Job execution - SQLite
persistence - Filesystem management

------------------------------------------------------------------------

# 6. Project Layout

projects/

    <project>/

        project.db

        images/

        thumbnails/

        exports/

        prompts/

            planner.md

            evaluator.md

        logs/

------------------------------------------------------------------------

# 7. Codex Adapter

Create an isolated adapter responsible for:

-   expandPrompt()
-   generateImages()
-   evaluateImages()
-   rewritePrompt()

The rest of the system must never invoke Codex directly.

------------------------------------------------------------------------

# 8. Workflow

User enters:

-   Original prompt
-   Variants per revision (default 4)
-   Optimization rounds (default 3)
-   Survivors per round (default 2)

Planner expands the prompt.

Generate N variants.

Evaluate all variants.

Rank.

Keep survivors.

Rewrite prompts.

Repeat.

Create child revisions.

------------------------------------------------------------------------

# 9. Prompt Planning

Inputs:

-   original prompt
-   parent image
-   optional edit prompt
-   up to two reference images

Output:

One expanded prompt sent to GPT Image.

------------------------------------------------------------------------

# 10. Evaluation

Evaluation compares generated image ONLY against:

-   original project prompt
-   image itself

Purpose:

Prevent prompt drift.

Evaluation returns:

-   score
-   strengths
-   weaknesses
-   recommended improvements
-   concise reasoning

Scores are used internally for ranking.

------------------------------------------------------------------------

# 11. References

Maximum two reference images.

References become immutable revision metadata.

------------------------------------------------------------------------

# 12. Graph UI

Use React Flow.

Images are graph nodes.

Edges represent creative decisions.

Edge labels contain metadata.

Node contains only:

-   image
-   selection outline
-   generation status

No permanent overlays.

------------------------------------------------------------------------

# 13. Canvas

Infinite pan.

Infinite zoom.

Drag nodes.

Persist node positions.

Automatic ELK layout only for newly created nodes.

Never relayout existing nodes automatically.

Provide explicit "Auto Layout" command.

------------------------------------------------------------------------

# 14. Inspector

Click image:

-   preview
-   original prompt
-   expanded prompt
-   evaluation
-   references
-   history

Click edge:

-   edit prompt
-   planner output
-   optimization summary
-   job log

------------------------------------------------------------------------

# 15. Projects

Homepage lists recent projects.

Project title automatically summarized by Codex.

Projects remain fully local.

------------------------------------------------------------------------

# 16. Revision Rules

Immutable.

Never edited.

Never deleted.

Every edit creates new leaves.

------------------------------------------------------------------------

# 17. Jobs

Jobs are mutable.

States:

Queued

Running

Completed

Failed

Cancelled (future)

Store jobs in SQLite.

Worker executes sequentially.

------------------------------------------------------------------------

# 18. Storage

SQLite only.

Images stored on disk.

No blobs in database.

------------------------------------------------------------------------

# 19. Logging

Persist:

-   planner prompts
-   planner responses
-   evaluation prompts
-   evaluation responses
-   generation prompts
-   generation metadata
-   errors

Use Pino.

------------------------------------------------------------------------

# 20. Images

Generate thumbnails with Sharp.

Never overwrite originals.

------------------------------------------------------------------------

# 21. UX Principles

Images first.

Metadata second.

Metadata belongs on edges and in inspector.

No intrusive labels.

No dashboard aesthetic.

Canvas is the product.

------------------------------------------------------------------------

# 22. Algorithms

Optimization:

Generate

Evaluate

Rank

Keep top survivors

Rewrite prompts

Repeat

Deterministic orchestration.

Only GPT Image introduces stochasticity.

------------------------------------------------------------------------

# 23. Error Handling

Retry failed Codex invocation.

Retry missing image.

Failed candidate should not invalidate entire batch.

------------------------------------------------------------------------

# 24. Deployment

One command:

make up

Starts:

-   Next.js
-   SQLite (embedded)
-   Worker

Application available on localhost.

------------------------------------------------------------------------

# 25. Design Principles

-   Local-first
-   Immutable revisions
-   Reproducible history
-   Images dominate the interface
-   Minimal infrastructure
-   Maximum reuse of mature open-source libraries
-   Custom code only for orchestration and optimization

------------------------------------------------------------------------

# 26. Future Extension Points

Potential additions:

-   Replay Revision
-   Multiple evaluation strategies
-   Plugin critics
-   Export graph
-   Batch rendering
-   Multiple optimization strategies

These must not require redesign of the core architecture.
