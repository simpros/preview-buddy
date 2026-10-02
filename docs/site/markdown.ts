// Markdown rendering for the published docs site.
//
// TanStack Markdown is the parser: markdown stays canonical, is parsed once
// into an AST, and rendered from there — heading ids, the "On this page"
// TOC, and the code block component all read the same tree. Two string-level
// post-steps remain, each documented at its site: table scroll containers
// and `.md` → `.html` link rewrites.
import { parseMarkdown } from "@tanstack/markdown";
import type {
  BlockNode,
  CodeBlockNode,
  MarkdownDocument,
  MarkdownExtension,
  MarkdownHeading,
} from "@tanstack/markdown";
import { renderHtml } from "@tanstack/markdown/html";
import { collectMarkdownHeadings } from "@tanstack/markdown/extensions/headings";
import { dirname, relative, resolve } from "node:path/posix";
import {
  codeBlockExtension,
  isPromptFence,
  PROMPT_FENCE_META,
} from "./codeblock.ts";

// GitHub's anchor rule: lowercase, drop everything but letters/numbers/marks,
// `_`, `-`, and spaces, then spaces become hyphens. Punctuation between
// spaces leaves double hyphens (`A → B` → `a--b`); that is the form historic
// external anchors use, so the HTML view must emit it too. Repeats dedupe
// GitHub-style (`head`, `head-1`, …).
export function slugHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "")
    .replace(/ /g, "-");
}

// Per-document slugger closing over its own repeat table, so the `.md`
// fragment namespace and the `.html` id namespace are literally one.
function githubHeadingIdsFn(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text: string) => {
    let slug = slugHeading(text);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    return slug;
  };
}

// Stateless across documents: the code block component only renders `code`
// nodes; headings are collected from the parsed tree with the library's own
// collector, so no bespoke heading model shadows the parser's.
const markdownExtensions: MarkdownExtension[] = [codeBlockExtension];

function parseMarkdownDocument(markdown: string): MarkdownDocument {
  return parseMarkdown(markdown, {
    allowHtml: true,
    headingIds: githubHeadingIdsFn(),
    extensions: markdownExtensions,
  });
}

function renderDocumentBody(document: MarkdownDocument): string {
  return withInlineTocSlot(
    wrapTables(
      renderHtml(document, {
        allowHtml: true,
        // No printed `#` beside headings: ids still ship (the TOC and every
        // `#fragment` link resolve against them) and each heading carries an
        // empty focusable link whose `#` is drawn by CSS on hover/focus, so
        // no literal character sits in the markup.
        headingAnchors: {
          content: "",
          className: "heading-anchor",
          tabIndex: 0,
          ariaHidden: false,
        },
        extensions: markdownExtensions,
      }),
    ),
  );
}

// Slot where the shell drops the inline "On this page" card: emitted here,
// next to the renderer that owns the body HTML, so the shell fills it by
// plain substitution instead of parsing the body to find the `h1`. Every
// rendered body carries exactly one slot — after the first heading close,
// or at the top when a page opens without one (no docs page does today;
// the fallback keeps the card from silently vanishing on a future one).
export const INLINE_TOC_SLOT = "<!--docs-inline-toc-->";

function withInlineTocSlot(bodyHtml: string): string {
  const close = bodyHtml.indexOf("</h1>");
  if (close === -1) return `${INLINE_TOC_SLOT}\n${bodyHtml}`;
  const at = close + "</h1>".length;
  return `${bodyHtml.slice(0, at)}\n${INLINE_TOC_SLOT}\n${bodyHtml.slice(at)}`;
}

// Rendered tables own their scroll container: the wrapper carries the
// overflow and the sticky header, so a wide table scrolls inside its box
// instead of pushing the page sideways.
const TABLEWRAP_OPEN = '<div class="tablewrap">';
function wrapTables(html: string): string {
  return html.replace(
    /<table[\s\S]*?<\/table>/g,
    (table: string) => `${TABLEWRAP_OPEN}${table}</div>`,
  );
}

// One parse+render pairing, owned here: every consumer parses and renders
// through this, so an extension added to one side cannot half-work.
export function renderMarkdown(markdown: string): {
  headings: MarkdownHeading[];
  body: string;
} {
  const document = parseMarkdownDocument(markdown);
  return { headings: collectMarkdownHeadings(document), body: renderDocumentBody(document) };
}

export function markdownToHtmlBody(markdown: string): string {
  return renderMarkdown(markdown).body;
}

// The single copy-paste block lives in `docs/onboarding-prompt.md` as the
// ```text fence carrying the prompt meta tag; every other surface embeds this
// extracted text. Read from the AST, not a fence regex, so a second fenced
// example inside the prompt can never silently truncate the extraction.
export function extractPromptText(markdown: string): string {
  const fences: CodeBlockNode[] = [];
  const visit = (nodes: BlockNode[]): void => {
    for (const node of nodes) {
      if (node.type === "code") {
        fences.push(node);
      } else if (node.type === "list") {
        for (const item of node.items) visit(item.children);
      } else if (node.type === "blockquote" || node.type === "callout") {
        visit(node.children);
      }
    }
  };
  visit(parseMarkdownDocument(markdown).children);
  const found = fences.find(isPromptFence);
  if (!found) {
    throw new Error("onboarding prompt source carries no ```text prompt block");
  }
  const text = found.value.trim();
  // A fence line inside the prompt cannot round-trip through `promptFence`,
  // so fail loudly instead of shipping a truncated block.
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      throw new Error("onboarding prompt contains a fence line");
    }
  }
  return text;
}

// Published `.md` stays a complete, self-contained prompt for agents. The
// meta tag survives into the HTML view, where the code-block extension
// reads it back as the onboarding copy label.
export function promptFence(prompt: string): string {
  return [`\`\`\`text ${PROMPT_FENCE_META}`, prompt, "```"].join("\n");
}

export function extractHtmlIds(html: string): string[] {
  const ids: string[] = [];
  const re = /id="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    ids.push(match[1]!);
  }
  return ids;
}

// One split for every consumer (renderer, gate): path before `?`/`#`,
// the untouched suffix after it, and the `#fragment` without the hash.
export function splitHref(href: string): {
  path: string;
  suffix: string;
  fragment: string | null;
} {
  const query = href.indexOf("?");
  const hash = href.indexOf("#");
  const end = Math.min(
    query === -1 ? href.length : query,
    hash === -1 ? href.length : hash,
  );
  return {
    path: href.slice(0, end),
    suffix: href.slice(end),
    fragment: hash === -1 ? null : href.slice(hash + 1),
  };
}

// Protocol links leave the artifact; same-page `#anchors` do not — they
// resolve against their own file in both the renderer and the gate. Any
// `scheme:` qualifies, so the inline `data:` payloads gated `src` targets
// can carry never resolve as relative paths.
export function isExternalHref(href: string): boolean {
  return href.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
}

// Rewrite intra-corpus `.md` links to their rendered `.html` twins (fragments
// preserved) so the human artifact never drops readers into raw source.
// Links to files with no HTML twin (examples, templates, env samples) pass
// through untouched. Regex over rendered HTML on purpose: the AST link nodes
// carry bare hrefs without the twin mapping, which only assembly knows.
export function rewritePageLinks(
  html: string,
  sourceFile: string,
  renderedHtmlPages: Set<string>,
): string {
  const dir = dirname(sourceFile);
  return html.replace(/href="([^"]+)"/g, (whole, href: string) => {
    if (isExternalHref(href)) return whole;
    const { path, suffix } = splitHref(href);
    if (!path.endsWith(".md")) return whole;
    const rel = relative(
      "/",
      resolve("/", dir, path).replace(/\.md$/, ".html"),
    );
    if (!renderedHtmlPages.has(rel)) return whole;
    return `href="${path.slice(0, -3)}.html${suffix}"`;
  });
}
