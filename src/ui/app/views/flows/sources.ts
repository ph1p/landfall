import { S, http, sv, errorMessage } from "../../lib/store";
import type { Redeploy } from "../../lib/types";
import type { LocalImage } from "../../../../core/deploy/buildlocal";
import { run, ifOk } from "../../lib/jobs";
import { toast } from "../../ui/toast";
import { dialog, invalid, siteNameError, type Values } from "../../ui/dialog";
import { defaultServer } from "./server-dialogs";
import { slugify } from "./names";
import { deployDialog } from "./deploy-dialog";
import { openAfter } from "./deploy";

/**
 * Deploy a Docker image (lf deploy --image), or redeploy a site that runs one. It runs in an empty folder:
 * the folder lf ui started in may hold another project's .landfall.json.
 */
export async function deployImage(site?: Redeploy) {
  try {
    const [images, { path }] = await Promise.all([http<LocalImage[]>("/api/images"), http<{ path: string }>("/api/image-folder", {})]);
    await deployDialog({ path, name: site?.name ?? "", kind: "image", stack: [] }, { site, images: images.map((i) => i.ref) });
  } catch (e) {
    toast(errorMessage(e));
  }
}

/** The repository's name in a git URL, for a site that has none: shop for git@github.com:acme/shop.git#main. */
const repoName = (url: string) =>
  url
    .replace(/#.*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split(/[/:]/)
    .pop() ?? "";

/**
 * Deploy a branch, tag or commit the server fetches itself (lf deploy --git): no folder here. Like an image,
 * it runs in an empty folder; the commit's own .landfall.json gives the settings.
 */
export async function deployRepo(o: { url?: string; ref?: string; name?: string; server?: string } = {}) {
  let path: string;
  try {
    ({ path } = await http<{ path: string }>("/api/image-folder", {}));
  } catch (e) {
    return toast(errorMessage(e));
  }
  const servers = S.state.servers.map((s) => ({ value: s.name, label: s.name }));
  const siteName = (v: Values) => v.name.trim() || slugify(repoName(v.url.trim()));
  dialog({
    title: o.name ? `Redeploy ${o.name} from git` : "Deploy from a git repository",
    text: "The server fetches the repository and builds the commit. Nothing is uploaded from here, and no local copy is needed.",
    fields: [
      {
        legend: "Repository",
        fields: [
          {
            name: "url",
            label: "Repository",
            value: o.url ?? "",
            mono: true,
            placeholder: "git@github.com:you/app.git or gh:you/app",
            required: "Which repository? For example git@github.com:you/app.git",
            check: (x: string) =>
              /\s/.test(x)
                ? "One URL, without spaces"
                : /^https?:\/\/[^/]*@/.test(x)
                  ? "No login in the URL: the server fetches with a deploy key"
                  : x.includes("#") && "Give the branch or tag below",
            hint: "SSH, HTTPS, gh:owner/repo, gl:group/repo, or a path on the server.",
          },
          {
            name: "ref",
            label: "Branch, tag or commit",
            value: o.ref ?? "",
            mono: true,
            placeholder: "the default branch",
            check: (x: string) => /\s|^-/.test(x) && "One branch, tag or commit",
          },
          {
            name: "key",
            label: "Give the server a deploy key first",
            type: "check",
            value: false,
            hint: "Once per server and private repository (lf git key). With gh or glab logged in here, it adds the key to the repository.",
          },
        ],
      },
      {
        legend: "Site",
        fields: [
          {
            row: [
              {
                name: "name",
                label: "Site name",
                value: o.name ?? "",
                placeholder: "the repository's name",
                check: (x: string) => x && siteNameError(x),
                preview: (v: Values) => !v.name.trim() && siteName(v) && `→ ${siteName(v)}`,
              },
              { name: "server", label: "Server", type: "select", options: servers, value: o.server ?? defaultServer() ?? "", required: "Pick a server" },
            ],
          },
          {
            name: "environment",
            label: "Environment",
            value: "",
            placeholder: "none",
            check: (x: string) => x && !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(x) && "Letters, digits, _ . and -",
            hint: "One of the environments in the commit's .landfall.json (lf deploy -E).",
          },
        ],
      },
    ],
    ok: o.name ? "Redeploy" : "Deploy",
    onOk: (v) => {
      const url = v.url.trim();
      const ref = v.ref.trim();
      const n = siteName(v);
      if (!n || siteNameError(n)) return invalid("name", "Give the site a name: lowercase letters, digits and dashes");
      const argv = [
        "deploy",
        "-y",
        ...sv(v.server),
        "-n",
        n,
        "--git",
        ref ? `${url}#${ref}` : url,
        ...(v.environment.trim() ? ["-E", v.environment.trim()] : []),
      ];
      const deploy = () => run(argv, { server: v.server, cwd: path, after: openAfter });
      if (v.key) run(["git", "key", url, ...sv(v.server), "-y"], { server: v.server, after: ifOk(deploy) });
      else deploy();
    },
  });
}
