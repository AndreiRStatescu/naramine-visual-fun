"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ArrowRightIcon,
  BranchIcon,
  CloseIcon,
  ImageIcon,
  SparklesIcon,
  UploadIcon,
} from "@/components/icons";
import {
  extractProjects,
  ProjectRecord,
  readApiJson,
  readCreatedProjectId,
} from "@/components/project-types";

const formatRecentDate = (value?: string) => {
  if (!value) return "Recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date);
};

function ProjectCard({ project }: { project: ProjectRecord }) {
  return (
    <Link className="recent-project-card" href={`/projects/${project.id}`}>
      <div className="recent-project-icon" aria-hidden="true">
        <ImageIcon size={19} />
      </div>
      <div className="recent-project-copy">
        <div className="recent-project-title-row">
          <h3>{project.title}</h3>
          <span>
            {formatRecentDate(project.lastOpenedAt ?? project.updatedAt)}
          </span>
        </div>
        <p>{project.originalPrompt || "An image exploration in progress"}</p>
        <div className="recent-project-meta">
          <span>{project.variantsPerRevision} variants</span>
          <i />
          <span>{project.optimizationRounds} rounds</span>
          <ArrowRightIcon size={16} />
        </div>
      </div>
    </Link>
  );
}

export function ProjectLauncher() {
  const router = useRouter();
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [variants, setVariants] = useState(4);
  const [rounds, setRounds] = useState(3);
  const [survivors, setSurvivors] = useState(2);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/projects", {
          signal: controller.signal,
          cache: "no-store",
        });
        const body = await readApiJson(response);
        setProjects(extractProjects(body));
      } catch (requestError) {
        if (!(
          requestError instanceof DOMException &&
          requestError.name === "AbortError"
        )) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "Could not load recent projects.",
          );
        }
      } finally {
        setLoadingProjects(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const expectedImages = useMemo(
    () => variants + Math.max(0, rounds - 1) * survivors * variants,
    [rounds, survivors, variants],
  );

  function chooseReferences(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = "";
    setReferenceFiles((current) => {
      const keyed = new Map(
        [...current, ...chosen].map((file) => [
          `${file.name}-${file.size}-${file.lastModified}`,
          file,
        ]),
      );
      return Array.from(keyed.values()).slice(0, 2);
    });
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (prompt.trim().length < 3) {
      setError("Give the exploration a little more direction first.");
      return;
    }
    if (survivors > variants) {
      setError("Survivors cannot exceed variants per revision.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const settings = {
        originalPrompt: prompt.trim(),
        variantsPerRevision: variants,
        optimizationRounds: rounds,
        survivorsPerRound: survivors,
      };
      let request: RequestInit;
      if (referenceFiles.length) {
        const formData = new FormData();
        formData.append("originalPrompt", settings.originalPrompt);
        formData.append(
          "variantsPerRevision",
          String(settings.variantsPerRevision),
        );
        formData.append(
          "optimizationRounds",
          String(settings.optimizationRounds),
        );
        formData.append(
          "survivorsPerRound",
          String(settings.survivorsPerRound),
        );
        formData.append("referenceIds", "[]");
        referenceFiles.forEach((file) => formData.append("files", file));
        request = { method: "POST", body: formData };
      } else {
        request = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...settings, referenceIds: [] }),
        };
      }
      const response = await fetch("/api/projects", request);
      const body = await readApiJson(response);
      const id = readCreatedProjectId(body);
      if (!id) throw new Error("The project was created without an id.");
      router.push(`/projects/${id}`);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not start the exploration.",
      );
      setSubmitting(false);
    }
  }

  return (
    <main className="home-shell">
      <div className="home-ambient home-ambient-one" />
      <div className="home-ambient home-ambient-two" />

      <header className="home-header">
        <Link className="brand" href="/" aria-label="Naramine home">
          <span className="brand-mark">
            <BranchIcon size={20} />
          </span>
          <span>Naramine</span>
        </Link>
        <span className="local-pill">
          <i /> Local workspace
        </span>
      </header>

      <section className="launch-grid">
        <div className="launch-intro">
          <div className="eyebrow">
            <SparklesIcon size={15} /> New exploration
          </div>
          <h1>
            Follow an image
            <br />
            until it feels right.
          </h1>
          <p>
            Start with an idea. Naramine generates, evaluates, and branches
            every direction without losing the path that got you there.
          </p>

          <div className="workflow-note" aria-label="Exploration workflow">
            <span>Prompt</span>
            <i />
            <span>Generate</span>
            <i />
            <span>Evaluate</span>
            <i />
            <span>Branch</span>
          </div>
        </div>

        <form className="launch-form" onSubmit={createProject}>
          <label className="prompt-field">
            <span>What do you want to explore?</span>
            <textarea
              autoFocus
              maxLength={8000}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="A quiet brutalist house set into a misty cliff, soft morning light, cinematic photography…"
              rows={7}
              value={prompt}
            />
            <small>{prompt.length.toLocaleString()} / 8,000</small>
          </label>

          <div className="initial-references">
            <div>
              <span>
                Visual references <small>Optional · up to 2</small>
              </span>
              <p>Guide composition or mood from the first generation.</p>
            </div>
            <div className="initial-reference-actions">
              {referenceFiles.map((file, index) => (
                <span
                  className="initial-reference-chip"
                  key={`${file.name}-${file.lastModified}`}
                  title={file.name}
                >
                  <ImageIcon size={13} />
                  <b>{file.name}</b>
                  <button
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      setReferenceFiles((current) =>
                        current.filter((_, itemIndex) => itemIndex !== index),
                      )
                    }
                    type="button"
                  >
                    <CloseIcon size={12} />
                  </button>
                </span>
              ))}
              {referenceFiles.length < 2 ? (
                <button
                  className="add-reference-button"
                  onClick={() => referenceInputRef.current?.click()}
                  type="button"
                >
                  <UploadIcon size={14} />
                  {referenceFiles.length ? "Add another" : "Add images"}
                </button>
              ) : null}
              <input
                accept="image/jpeg,image/png,image/webp,image/avif"
                hidden
                multiple
                onChange={chooseReferences}
                ref={referenceInputRef}
                type="file"
              />
            </div>
          </div>

          <div className="generation-settings">
            <label>
              <span>Variants</span>
              <select
                value={variants}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setVariants(next);
                  setSurvivors((current) => Math.min(current, next));
                }}
              >
                {[2, 3, 4, 5, 6, 7, 8].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Rounds</span>
              <select
                value={rounds}
                onChange={(event) => setRounds(Number(event.target.value))}
              >
                {[1, 2, 3, 4, 5, 6].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Survivors</span>
              <select
                value={survivors}
                onChange={(event) => setSurvivors(Number(event.target.value))}
              >
                {Array.from(
                  { length: Math.min(4, variants) },
                  (_, index) => index + 1,
                ).map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="launch-submit-row">
            <span>Up to {expectedImages} images across the full run</span>
            <button
              className="primary-button"
              disabled={submitting}
              type="submit"
            >
              {submitting ? (
                <span className="button-spinner" />
              ) : (
                <SparklesIcon size={17} />
              )}
              {submitting ? "Starting…" : "Begin exploration"}
            </button>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </section>

      <section className="recent-section">
        <div className="section-heading">
          <h2>Recent explorations</h2>
          {projects.length ? (
            <span>
              {projects.length} local{" "}
              {projects.length === 1 ? "project" : "projects"}
            </span>
          ) : null}
        </div>
        <div className="recent-list">
          {loadingProjects ? (
            <>
              <div className="project-skeleton" />
              <div className="project-skeleton" />
            </>
          ) : projects.length ? (
            projects
              .slice(0, 8)
              .map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))
          ) : (
            <div className="empty-projects">
              <span>
                <ImageIcon size={20} />
              </span>
              <div>
                <h3>Your paths will gather here.</h3>
                <p>
                  Start an exploration above and every branch will remain
                  available locally.
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      <footer className="home-footer">
        <span>Immutable revisions. Nothing overwritten.</span>
        <span>Images and metadata stay on this machine.</span>
      </footer>
    </main>
  );
}
