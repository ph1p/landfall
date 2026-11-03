/** A site name from a folder or file name: what SITE_NAME accepts. Shared by the CLI and the web UI. */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "site";
