# Architecture

## Domain model

A `Revision` is an immutable generation batch. The first revision has no source
image. Every later revision records one `sourceImageId`, and all images produced
inside that revision receive an edge from that source image. Sibling images
therefore share planning and provenance metadata while remaining individually
selectable canvas nodes.

Reference assets are copied into project storage, hashed, and joined to the
revision that used them. References do not become ancestry edges. This keeps
the creative graph acyclic while preserving exact inputs.

Operational writes are deliberately separated:

- immutable: revision, generated image, evaluation, creative edge, reference;
- mutable: job, candidate attempt, job event, canvas position, project title.

The application does not expose revision or image deletion.

One global SQLite catalog stores every project's relational metadata. Project
directories contain only binary assets, prompt seeds, logs, transient work, and
future exports; they do not contain per-project databases.

## Process boundary

The Next.js process owns HTTP routes and the React application. A second native
Node process claims one queued SQLite job at a time. Within that job, candidate
pipelines use a bounded pool of at most four; jobs and immutable round commits
remain sequential. On startup the worker recovers jobs whose previous lease
became stale. Candidate failures are recorded and do not discard successful
siblings.

Both development and production servers bind to `127.0.0.1`. API routes reject
non-loopback hosts, and browser mutations also require an exact same-origin
loopback request. This is the trust boundary for the intentionally unauthenticated
single-user service.

Candidate attempts are mutable and may be projected into the graph as transient
queued, generating, evaluating, prepared, or failed nodes. Once trusted code
publishes a generated PNG and thumbnail, that provisional node serves the real
artifact immediately while evaluation continues. A successful attempt keeps
the same deterministic node identity when its whole revision batch is
finalized. Transient canvas positions remain client-side; only finalized image
positions are persisted.

Before generation, the worker atomically journals each branch plan under a
trusted job provenance directory that Codex cannot write. Candidate generation
and evaluation records are then bound to the artifact's SHA-256. A recovered
worker reuses those exact records, so a new planner or critic response cannot be
misattributed to pre-crash image bytes. The journal is removed after the job's
immutable database transactions complete.

All Codex interaction goes through `src/server/codex`. The orchestration layer
depends on its interface rather than spawning Codex itself. The fake adapter is
the default; the real adapter is enabled only with `CODEX_ADAPTER=codex`.

## Optimization topology

Selection is global within each local optimization round:

```text
round 1        one revision × four images
                       │
                 top two survive
                  ╱             ╲
round 2   one revision × 4   one revision × 4
                  ╲             ╱
                 top two survive
                  ╱             ╲
round 3   one revision × 4   one revision × 4
```

An exploration launched from an existing node uses that image as the source of
its first local round. Its persisted revision round continues from the source
revision's graph depth.

## Codex boundary

Text operations use `codex exec --ephemeral` and strict JSON Schema output.
Image inputs are attached with `-i`. Generation asks the `$imagegen` skill to
derive a slightly varied final prompt for its candidate slot and create one
artifact in a candidate-scoped writable directory. The exact final prompt is
returned with the path and persisted on the generated image. Trusted code
validates the artifact, copies it to immutable image storage with a fresh inode,
creates its thumbnail, and exposes it through the provisional node. The
evaluator then reviews that published read-only artifact. Codex never receives
write access to the immutable image directory.

The public Codex documentation describes noninteractive structured output and
image generation, but does not promise a dedicated stable binary-artifact API
for `codex exec`. Keeping this behavior inside the adapter prevents that detail
from leaking into jobs, persistence, or UI code.
