import { ApiError } from "@/app/api/_lib/http";

export function imageFilesFromForm(formData: FormData): File[] {
  const entries = [
    ...formData.getAll("references"),
    ...formData.getAll("files"),
    ...formData.getAll("file"),
  ];
  const seen = new Set<FormDataEntryValue>();
  const files: File[] = [];

  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);

    if (typeof entry === "string") {
      throw new ApiError(400, "Reference fields must contain image files");
    }
    if (entry.size > 0) files.push(entry);
  }

  if (files.length > 2) {
    throw new ApiError(400, "A revision can use at most two reference images");
  }

  return files;
}

export function optionalFormString(
  formData: FormData,
  name: string,
): string | undefined {
  const value = formData.get(name);
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(400, `${name} must be a text field`);
  }
  return value;
}
