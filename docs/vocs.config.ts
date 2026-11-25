// The documentation site: `pnpm docs:dev` serves it, `pnpm docs:build` writes docs/dist.
// The pages are the Markdown files in docs/pages; they read the same on GitHub.
// Served from GitHub Pages at https://ph1p.github.io/landfall/ by .github/workflows/pages.yml.
import { defineConfig } from "vocs/config";

export default defineConfig({
  title: "landfall",
  description: "Set up Linux servers and deploy sites to them behind Traefik with automatic HTTPS, from one CLI.",
  basePath: "/landfall",
  baseUrl: "https://ph1p.github.io",
  srcDir: ".",
  outDir: "dist",
  renderStrategy: "full-static",
  editLink: { link: "https://github.com/ph1p/landfall/edit/main/docs/pages/:path", text: "Edit this page" },
  socials: [{ icon: "github", link: "https://github.com/ph1p/landfall" }],
  topNav: [
    { text: "Guide", link: "/deploy" },
    { text: "Reference", link: "/reference" },
  ],
  sidebar: [
    { text: "Introduction", link: "/" },
    {
      text: "Sites",
      items: [
        { text: "Deploy a site", link: "/deploy" },
        { text: "Day-to-day", link: "/sites" },
        { text: "Compose sites", link: "/compose" },
        { text: "Scaling and load balancing", link: "/scaling" },
        { text: "Lifecycle hooks", link: "/hooks" },
        { text: "Volumes and backups", link: "/volumes" },
        { text: "Git deploys", link: "/git" },
      ],
    },
    {
      text: "Servers",
      items: [
        { text: "Servers", link: "/servers" },
        { text: "Server administration", link: "/system" },
        { text: "Updates", link: "/updates" },
        { text: "Traefik", link: "/traefik" },
        { text: "Traffic, certificates and checks", link: "/monitoring" },
        { text: "History and undo", link: "/history" },
      ],
    },
    {
      text: "Tools",
      items: [
        { text: "Web UI", link: "/web-ui" },
        { text: "Plugins", link: "/plugins" },
        { text: "Scripts, CI and AI agents", link: "/automation" },
        { text: "Troubleshooting", link: "/troubleshooting" },
      ],
    },
    { text: "Reference", link: "/reference" },
  ],
});
