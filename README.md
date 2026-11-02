# Image Exploration Version Control System

A local-first workspace for exploring GPT Image generations as an immutable
graph. Each revision is a batch, each generated image is a canvas node, and
every refinement creates new descendants without replacing earlier work.

## Quick start

Requirements: Node.js 22+, pnpm 11+, and (for real generations) an authenticated
Codex CLI.

```bash
make up
```

Open [http://localhost:3000](http://localhost:3000). `make up` starts the Next.js
application and the sequential worker as native local processes; its setup
dependency installs packages and deploys pending SQLite migrations first.
The web process binds to `127.0.0.1` and mutation routes require a same-loopback
browser origin. Docker is intentionally not part of the current setup.

The default `CODEX_ADAPTER=fake` mode creates deterministic placeholder images,
so the complete workflow can be exercised without consuming Codex usage. To
opt into GPT Image generation:

```bash
codex login status
CODEX_ADAPTER=codex make up
```

The real adapter invokes `codex exec` with argument arrays, an output schema,
an isolated job directory, explicit timeouts, and no shell interpolation. Image
generation counts against the limits of the account authenticated in Codex.

## Workflow

1. Create a project from an original prompt.
2. The planner expands the prompt and generates four candidates by default.
3. Each image is evaluated independently against only the original prompt.
4. The top two candidates survive globally.
5. Every survivor starts a child revision containing four new candidates.
6. The process repeats for the configured number of rounds.

With the defaults, one job creates 20 images: `4 + (2 × 4) + (2 × 4)`.
Scores are ranked from 0–100 and ties are resolved by stable image ID.

## Local data

Metadata lives in one SQLite database. Binary assets are never stored as
database blobs.

```text
data/
  ievcs.db
  projects/<project-id>/
    images/
    thumbnails/
    exports/
    prompts/
      planner.md
      evaluator.md
    logs/
    work/
```

Original images and immutable reference copies receive unique filenames and
content hashes. Canvas positions, jobs, and attempts are mutable operational
state; finalized revisions, images, evaluations, edges, and references have no
update or delete routes.

## Configuration

Copy `.env.example` to `.env` (performed automatically by `make setup`):

| Variable                    | Default                 | Purpose                              |
| --------------------------- | ----------------------- | ------------------------------------ |
| `DATABASE_URL`              | `file:../data/ievcs.db` | Global Prisma SQLite connection      |
| `IEVCS_DATA_ROOT`           | `./data`                | Project assets and logs              |
| `IEVCS_MAX_REFERENCE_BYTES` | `20971520`              | Per-reference upload limit           |
| `CODEX_ADAPTER`             | `fake`                  | `fake` or explicit opt-in `codex`    |
| `CODEX_BIN`                 | `codex`                 | Codex CLI executable                 |
| `CODEX_TIMEOUT_MS`          | `600000`                | Per-invocation timeout               |
| `CODEX_RETRIES`             | `2`                     | Retries after a failed/missing run   |
| `CODEX_IMAGE_CONCURRENCY`   | `4`                     | Concurrent candidate pipelines (1–4) |
| `WORKER_POLL_MS`            | `1500`                  | Sequential worker polling interval   |
| `WORKER_STALE_MS`           | `900000`                | Lease age before abandoned recovery  |
| `WORKER_HEARTBEAT_MS`       | `30000`                 | Running-job lease refresh interval   |

## Development

```bash
pnpm dev          # web + worker
pnpm dev:web      # web only
pnpm worker:dev   # worker only
pnpm db:studio
```

Run the complete local verification suite with:

```bash
make check
```

The technical source specification is preserved at
[`tasks/Image_Exploration_Version_Control_System_Technical_Spec.md`](tasks/Image_Exploration_Version_Control_System_Technical_Spec.md).

## Real image invocation

Each real candidate runs in its own isolated `codex exec` process. Jobs remain
sequential, while at most `CODEX_IMAGE_CONCURRENCY` candidate pipelines run at
once (hard-capped at four). A generated PNG and thumbnail become visible as a
provisional graph node before evaluation and atomic revision finalization.

The four-slot default is based on the first real run: generation took 193–225
seconds per candidate, evaluation took 17–24 seconds, and local CPU use stayed
around 1–4%, indicating remote-bound work. Four isolated pipelines therefore
turn a four-image serial wave of roughly 14–16 minutes into a roughly four-minute
wave without allowing an unbounded number of Codex processes.

The adapter invokes Codex with these arguments:

```text
codex exec
  --ephemeral
  --skip-git-repo-check
  --color never
  --sandbox workspace-write
  [-i <parent-image> <reference-image-1> <reference-image-2>]
  --add-dir <candidate-output-directory>
  --output-schema <temporary-schema.json>
  --output-last-message <temporary-response.json>
  --cd <isolated-temporary-directory>
  -
```

The prompt is piped on standard input. It names `$imagegen` and includes the
shared revision prompt, the candidate's one-based slot and revision batch size,
a slot-specific variation focus, a stable candidate key, and the exact absolute
PNG output path. Codex derives a faithful but slightly varied final imagegen
prompt and returns that exact `finalPrompt` with the created path; it is stored
as the generated image's prompt. No model, size, aspect-ratio, quality, or
image-format flag is passed to `codex exec`; PNG and the requested composition
are specified in the prompt, and the imagegen skill chooses the produced
dimensions. The process inherits the worker environment, has a per-invocation
timeout controlled by `CODEX_TIMEOUT_MS`, and retries according to
`CODEX_RETRIES`.
