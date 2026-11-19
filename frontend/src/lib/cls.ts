/** Joins the class names that are set: cls("row", gone && "gone") -> "row gone" or "row". */
export function cls(...parts: (string | false | null | undefined | 0)[]): string {
  return parts.filter(Boolean).join(" ");
}
