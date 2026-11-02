"use client";

import { ChangeEvent, FormEvent, useRef, useState } from "react";

import { ArrowLeftIcon, SparklesIcon, UploadIcon } from "@/components/icons";
import {
  ImageRecord,
  readApiJson,
  readUploadedReferences,
  ReferenceRecord,
} from "@/components/project-types";

type ExploreFormProps = {
  projectId: string;
  image: ImageRecord;
  references: ReferenceRecord[];
  onBack: () => void;
  onReferencesUploaded: (references: ReferenceRecord[]) => void;
  onStarted: () => Promise<void> | void;
};

export function ExploreForm({
  projectId,
  image,
  references,
  onBack,
  onReferencesUploaded,
  onStarted,
}: ExploreFormProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [selectedReferences, setSelectedReferences] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleReference(id: string) {
    setError(null);
    setSelectedReferences((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 2) {
        setError("You can use up to two reference images.");
        return current;
      }
      return [...current, id];
    });
  }

  async function uploadFiles(event: ChangeEvent<HTMLInputElement>) {
    const available = 2 - selectedReferences.length;
    const files = Array.from(event.target.files ?? []).slice(0, available);
    event.target.value = "";
    if (!files.length) {
      if (available === 0)
        setError("Remove a reference before uploading another.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      const response = await fetch(`/api/projects/${projectId}/references`, {
        method: "POST",
        body: formData,
      });
      const body = await readApiJson(response);
      const uploaded = readUploadedReferences(body);
      if (!uploaded.length)
        throw new Error("No reference was returned after upload.");
      onReferencesUploaded(uploaded);
      setSelectedReferences((current) =>
        [...current, ...uploaded.map((reference) => reference.id)].slice(0, 2),
      );
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not upload the reference.",
      );
    } finally {
      setUploading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/explore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceImageId: image.id,
          editPrompt: editPrompt.trim() || undefined,
          referenceIds: selectedReferences,
        }),
      });
      await readApiJson(response);
      await onStarted();
      onBack();
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not queue this exploration.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="explore-form" onSubmit={submit}>
      <div className="inspector-header explore-header">
        <button
          className="icon-button"
          onClick={onBack}
          type="button"
          aria-label="Back to image details"
        >
          <ArrowLeftIcon size={18} />
        </button>
        <div>
          <span>Branch from image</span>
          <h2>Explore a new direction</h2>
        </div>
      </div>

      <div className="explore-parent-preview">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          alt="Selected parent"
          src={image.thumbnailUrl ?? `/api/images/${image.id}?thumbnail=1`}
        />
        <span>Every result becomes a new immutable child revision.</span>
      </div>

      <label className="inspector-field">
        <span>
          Edit direction <small>Optional</small>
        </span>
        <textarea
          autoFocus
          maxLength={8000}
          onChange={(event) => setEditPrompt(event.target.value)}
          placeholder="Keep the composition, but make the light warmer and the materials more tactile…"
          rows={6}
          value={editPrompt}
        />
        <small className="field-hint">
          Leave blank to explore variations that stay close to this image.
        </small>
      </label>

      <fieldset className="reference-picker">
        <div className="reference-picker-heading">
          <div>
            <legend>References</legend>
            <span>{selectedReferences.length} / 2 selected</span>
          </div>
          <button
            className="quiet-button"
            disabled={uploading || selectedReferences.length >= 2}
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            {uploading ? (
              <span className="mini-spinner" />
            ) : (
              <UploadIcon size={15} />
            )}
            {uploading ? "Uploading…" : "Upload"}
          </button>
          <input
            accept="image/jpeg,image/png,image/webp,image/avif"
            hidden
            multiple
            onChange={uploadFiles}
            ref={inputRef}
            type="file"
          />
        </div>

        {references.length ? (
          <div className="reference-grid">
            {references.map((reference) => {
              const isSelected = selectedReferences.includes(reference.id);
              return (
                <button
                  aria-pressed={isSelected}
                  className={`reference-option ${isSelected ? "is-selected" : ""}`}
                  key={reference.id}
                  onClick={() => toggleReference(reference.id)}
                  type="button"
                >
                  <span className="reference-thumb">
                    {reference.url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt="" src={reference.url} />
                    ) : (
                      <span>
                        {reference.originalName.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </span>
                  <span title={reference.originalName}>
                    {reference.originalName}
                  </span>
                  <i>{isSelected ? "✓" : ""}</i>
                </button>
              );
            })}
          </div>
        ) : (
          <button
            className="reference-empty"
            onClick={() => inputRef.current?.click()}
            type="button"
          >
            <UploadIcon size={19} />
            <span>
              <strong>Add a visual reference</strong>
              <small>PNG, JPG, WebP, or AVIF</small>
            </span>
          </button>
        )}
      </fieldset>

      {error ? (
        <p className="form-error inspector-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="explore-submit-area">
        <button
          className="primary-button explore-submit"
          disabled={submitting || uploading}
          type="submit"
        >
          {submitting ? (
            <span className="button-spinner" />
          ) : (
            <SparklesIcon size={17} />
          )}
          {submitting ? "Queuing branch…" : "Generate child revisions"}
        </button>
        <p>Uses the project&apos;s generation and optimization settings.</p>
      </div>
    </form>
  );
}
