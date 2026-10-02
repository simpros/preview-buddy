import { asc, ne } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { deriveMailFromName } from "@sprout/preview-env";
import type { DashboardConfig } from "../config.ts";
import { resolveForgeKind } from "../forge/kind.ts";
import type { StateDb } from "../infrastructure/db/client.ts";
import { previews } from "../infrastructure/db/schema.ts";
import { toDisplayStatus } from "../preview/lifecycle.ts";
import { storedProvider } from "../preview/row.ts";
import { parsePreviewStatus } from "../preview/snapshot.ts";

export type DashboardDeps = {
  db: StateDb;
  dashboard: DashboardConfig;
  mailboxUrl?: string;
  extraGitlabHosts?: ReadonlySet<string>;
};

export type DashboardRow = {
  slug: string;
  prId: number;
  prUrl: string | null;
  status: string;
  previewUrl: string;
  hostname: string;
  dbName: string | null;
  dbProvider: string;
  createdAt: string;
  updatedAt: string;
  mailFrom?: string;
  mailFromName?: string;
  mailboxUrl?: string;
  lastError?: string;
};

function forgePullRequestUrl(
  canonicalRepoId: string,
  prId: number,
  extraGitlabHosts?: ReadonlySet<string>,
): string | null {
  let kind: "github" | "gitlab";
  try {
    kind = resolveForgeKind(canonicalRepoId, { extraGitlabHosts });
  } catch {
    return null;
  }
  const base = canonicalRepoId.replace(/\/+$/, "");
  return kind === "github"
    ? `${base}/pull/${prId}`
    : `${base}/-/merge_requests/${prId}`;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One SELECT for any number of previews; never touches containers. */
export async function listDashboardRows(
  db: StateDb,
  opts: {
    mailboxUrl?: string;
    extraGitlabHosts?: ReadonlySet<string>;
  } = {},
): Promise<DashboardRow[]> {
  const rows = await db
    .select()
    .from(previews)
    .where(ne(previews.status, "removed"))
    .orderBy(asc(previews.slug), asc(previews.prId));
  return rows.map((row) => {
    const status = parsePreviewStatus(row.status);
    if (!status.ok) throw new Error(status.error);
    const mailFrom = row.mailFrom ?? undefined;
    return {
      slug: row.slug,
      prId: row.prId,
      prUrl: forgePullRequestUrl(row.canonicalRepoId, row.prId, opts.extraGitlabHosts),
      status: toDisplayStatus(status.value),
      previewUrl: `https://${row.hostname}`,
      hostname: row.hostname,
      dbName: row.dbName,
      dbProvider: storedProvider(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(mailFrom !== undefined
        ? {
            mailFrom,
            mailFromName: deriveMailFromName(row.slug, row.prId),
            ...(opts.mailboxUrl !== undefined
              ? { mailboxUrl: opts.mailboxUrl }
              : {}),
          }
        : {}),
      ...(row.lastError != null ? { lastError: row.lastError } : {}),
    };
  });
}

function renderRowCells(row: DashboardRow): string {
  const pr = row.prUrl
    ? `<a href="${escapeHtml(row.prUrl)}">#${row.prId}</a>`
    : `#${row.prId}`;
  const mail = row.mailFrom
    ? escapeHtml(
        row.mailboxUrl
          ? `${row.mailFrom} (${row.mailboxUrl})`
          : row.mailFrom,
      )
    : "—";
  const outcome = row.lastError ? escapeHtml(row.lastError) : row.status === "running" ? "healthy" : escapeHtml(row.status);
  return [
    `<td data-label="Preview">${escapeHtml(row.slug)} ${pr}</td>`,
    `<td data-label="Status">${escapeHtml(row.status)}</td>`,
    `<td data-label="URL"><a href="${escapeHtml(row.previewUrl)}">${escapeHtml(row.hostname)}</a></td>`,
    `<td data-label="Database">${escapeHtml(row.dbName ?? "—")} <span class="muted">${escapeHtml(row.dbProvider)}</span></td>`,
    `<td data-label="Created">${escapeHtml(row.createdAt)}</td>`,
    `<td data-label="Last deploy">${escapeHtml(row.updatedAt)}</td>`,
    `<td data-label="Mail">${mail}</td>`,
    `<td data-label="Outcome">${outcome}</td>`,
  ].join("");
}

export function renderDashboard(rows: DashboardRow[]): string {
  const body =
    rows.length === 0
      ? `<p class="empty">No live previews.</p>`
      : `<div class="table-wrap"><table>
          <thead><tr><th>Preview</th><th>Status</th><th>URL</th><th>Database</th><th>Created</th><th>Last deploy</th><th>Mail</th><th>Outcome</th></tr></thead>
          <tbody>${rows.map((row) => `<tr data-slug="${escapeHtml(row.slug)}" data-pr="${row.prId}">${renderRowCells(row)}</tr>`).join("")}</tbody>
        </table></div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sprout previews</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 72rem; padding: 1rem; line-height: 1.5; }
h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
p.sub { margin: 0 0 1rem; opacity: 0.75; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
th, td { border: 1px solid #8884; text-align: left; padding: 0.625rem; vertical-align: top; }
thead th { white-space: nowrap; }
.muted { opacity: 0.65; }
a { padding: 0.375rem 0.25rem; }
.empty { padding: 2rem 0; opacity: 0.75; }
@media (max-width: 40rem) {
  thead { display: none; }
  table, tbody, tr, td { display: block; width: 100%; box-sizing: border-box; }
  tr { border: 1px solid #8884; margin-bottom: 0.75rem; }
  td { border: 0; border-bottom: 1px solid #8884; }
  td:last-child { border-bottom: 0; }
  td::before { content: attr(data-label); display: block; font-weight: 600; font-size: 0.75rem; opacity: 0.7; }
}
</style>
</head>
<body>
<h1>Sprout previews</h1>
<p class="sub">${rows.length} live preview${rows.length === 1 ? "" : "s"}. Operator only: hostnames listed here are internal.</p>
${body}
</body>
</html>`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseBasicCredentials(header: string | null): {
  user: string;
  password: string;
} | null {
  if (!header) return null;
  const match = /^Basic\s+(\S+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return { user: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

export function isDashboardAuthorized(
  request: Request,
  dashboard: Pick<DashboardConfig, "user" | "password">,
): boolean {
  const creds = parseBasicCredentials(request.headers.get("authorization"));
  if (!creds) return false;
  return (
    safeEqual(creds.user, dashboard.user) &&
    safeEqual(creds.password, dashboard.password)
  );
}

function requestHostname(request: Request): string {
  const header = request.headers.get("host") ?? "";
  const raw =
    header !== ""
      ? header
      : (() => {
          try {
            return new URL(request.url).hostname;
          } catch {
            return "";
          }
        })();
  return raw.split(",")[0]?.split(":")[0]?.trim().toLowerCase() ?? "";
}

function dashboardHostAllowed(
  request: Request,
  host: string | undefined,
): boolean {
  if (!host) return true;
  return requestHostname(request) === host.toLowerCase();
}

export function getDashboard(deps: DashboardDeps) {
  const { db, dashboard } = deps;
  return async ({ request }: { request: Request }): Promise<Response> => {
    if (!dashboardHostAllowed(request, dashboard.host)) {
      return new Response("Not Found", { status: 404 });
    }
    if (!isDashboardAuthorized(request, dashboard)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="sprout-dashboard"' },
      });
    }
    let rows: DashboardRow[];
    try {
      rows = await listDashboardRows(db, {
        mailboxUrl: deps.mailboxUrl,
        extraGitlabHosts: deps.extraGitlabHosts,
      });
    } catch {
      return Response.json({ error: "dashboard_failed" }, { status: 500 });
    }
    return new Response(renderDashboard(rows), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  };
}
