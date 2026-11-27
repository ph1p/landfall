// Files that do not belong on a web server. No node: imports: lf security reads it for the files already on a
// server, the exposure check for those a deploy would upload.
import { globRe } from "../deploy/refs";

export type Severity = "high" | "medium" | "low";
const SEVERITY_ORDER: Severity[] = ["high", "medium", "low"];

/** A kind of file that should not be on a public server. Names are basename globs (`*` and `?`). */
interface FileRule {
  names: string[];
  dir?: boolean;
  /** Names that match but are fine (.env.example). */
  except?: string[];
  /** Only when the file holds a private key (a .pem may be a public certificate). */
  key?: boolean;
  severity: Severity;
  why: string;
}

export const FILE_RULES: FileRule[] = [
  {
    names: [".env", ".env.*"],
    except: [".env.example", ".env.sample", ".env.template", ".env.dist"],
    severity: "high",
    why: "environment file: passwords and API keys",
  },
  { names: [".git"], dir: true, severity: "high", why: "git history: old commits can hold removed secrets, its config a token" },
  { names: ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "*.ppk"], severity: "high", why: "a private SSH key" },
  { names: ["*.pem", "*.key"], key: true, severity: "high", why: "a private key" },
  { names: ["*.p12", "*.pfx", "*.jks", "*.keystore"], severity: "high", why: "a key store" },
  { names: [".ssh", ".aws", ".azure", ".kube", ".gnupg"], dir: true, severity: "high", why: "keys or cloud credentials" },
  {
    names: [".npmrc", ".pypirc", ".netrc", ".git-credentials", ".pgpass", ".my.cnf", ".htpasswd"],
    severity: "high",
    why: "may hold a registry token or passwords",
  },
  { names: ["*.tfstate", "*.tfstate.backup"], severity: "high", why: "Terraform state: every secret Terraform knows" },
  { names: [".secrets", "credentials.json", "service-account*.json"], severity: "high", why: "credentials" },
  {
    names: [".bash_history", ".zsh_history", ".python_history", ".psql_history", ".mysql_history"],
    severity: "high",
    why: "shell history: commands with passwords",
  },
  {
    names: [".claude", ".cursor", ".windsurf", ".aider*"],
    dir: true,
    severity: "medium",
    why: "AI agent settings: permissions, hooks, notes about your machine",
  },
  { names: ["CLAUDE.local.md", "settings.local.json"], severity: "medium", why: "personal agent settings" },
  { names: ["*.sql", "*.sql.gz", "*.dump", "*.sqlite", "*.sqlite3", "*.db"], except: ["Thumbs.db"], severity: "medium", why: "a database or dump: user data" },
  { names: [".svn", ".hg"], dir: true, severity: "medium", why: "version control history" },
  {
    names: ["*.bak", "*.old", "*.orig", "*.save", "*.swp", "*.swo", "*~"],
    severity: "medium",
    why: "a backup or swap file: served as plain text, source code included",
  },
  { names: [".DS_Store", "Thumbs.db", "desktop.ini"], severity: "low", why: "folder metadata: lists the folder's file names" },
  { names: ["__MACOSX"], dir: true, severity: "low", why: "macOS archive leftovers" },
  { names: [".vscode", ".idea"], dir: true, severity: "low", why: "editor settings" },
  { names: ["*.log"], severity: "low", why: "a log file" },
];

/** Names whose files count only when they hold a private key: *.pem may be a public certificate. */
export const KEY_NAMES = FILE_RULES.filter((r) => r.key).flatMap((r) => r.names);
const KEY_RE = KEY_NAMES.map(globRe);
/** Whether a file of this name counts only with a private key in it. */
export const keyName = (name: string) => KEY_RE.some((re) => re.test(name));

const COMPILED = FILE_RULES.map((r) => ({ r, re: r.names.map(globRe), except: new Set(r.except ?? []) }));

/** The rule a file or folder name falls under, if any. hasKey: whether the file holds a private key (for *.pem, *.key). */
export function classify(name: string, dir: boolean, hasKey = false): FileRule | undefined {
  for (const { r, re, except } of COMPILED) {
    if (!!r.dir !== dir || except.has(name) || !re.some((x) => x.test(name))) continue;
    if (r.key && !hasKey) continue;
    return r;
  }
}

export const bySeverity = <T extends { severity: Severity }>(a: T, b: T) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
