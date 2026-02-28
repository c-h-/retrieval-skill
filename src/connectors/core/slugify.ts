/**
 * Convert text to a filesystem-safe slug.
 */
export function slugify(text: string, maxLength = 80): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[_\s]+/g, "-") // spaces/underscores to hyphens first
    .replace(/[^a-z0-9-]/g, "") // remove non-alphanumeric
    .replace(/-+/g, "-") // collapse multiple hyphens
    .replace(/^-|-$/g, "") // trim leading/trailing hyphens
    .slice(0, maxLength)
    .replace(/-$/, ""); // trim trailing hyphen after slice
}

/**
 * Create a unique slug by appending a short ID suffix.
 */
export function uniqueSlug(text: string, id: string, maxLength = 80): string {
  const shortId = id.replace(/-/g, "").slice(0, 8);
  const base = slugify(text, maxLength - shortId.length - 1);
  if (!base) return shortId;
  return `${base}-${shortId}`;
}

/**
 * Sanitize a filename for safe filesystem use.
 */
export function sanitizeFilename(name: string, maxLength = 200): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, maxLength);
}
