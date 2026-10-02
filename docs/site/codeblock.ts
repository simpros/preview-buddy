// Copyable fenced-block component for the published docs site.
//
// Every fenced block on every published page renders through
// `codeBlockFigure` via `codeBlockExtension`, so markdown surfaces cannot
// drift; the marketing page's one static snippet is the same markup written
// by hand. The inlined client script is the single behaviour source: no
// dependencies, no fetch, one `<script>` per page.
import type { MarkdownExtension } from "@tanstack/markdown";
import { escapeHtml } from "./html.ts";

// Meta tag on the assembled prompt fence: the onboarding prompt renders
// through the same extension as every other fence, but keeps its
// distinctive copy label.
export const PROMPT_FENCE_META = "prompt";
export const PROMPT_COPY_LABEL = "Copy onboarding prompt";
// Display label for the prompt block: prose in a `text` fence renders
// unhighlighted, so the header says what it is instead of just `text`.
export const PROMPT_LANG_LABEL = "text · prompt";
// Source file shown in the prompt header, matching the hand-written
// marketing snippet that names its file the same way.
export const PROMPT_SOURCE_FILE = "onboarding-prompt.md";

export function isPromptFence(node: { meta?: string }): boolean {
  return node.meta?.split(/\s+/).includes(PROMPT_FENCE_META) ?? false;
}

// A filename token in the fence meta (` ```yaml .sprout.yaml `) names the
// source file shown in the header. The only other meta token the fence
// contract allows is the `prompt` tag, so the first token that is not the tag
// is the file and anything else is absent, never shape-sniffed.
export function fileFromMeta(meta: string | undefined): string | undefined {
  if (!meta) return undefined;
  return meta.split(/\s+/).find((token) => token.length > 0 && token !== PROMPT_FENCE_META);
}

// The header is explicit data, never derived: callers that know the fence
// contract pass the exact labels to render, so changing copy wording cannot
// silently rewrite the language line or inject a filename.
export type CodeBlockHeader = {
  copyLabel?: string;
  langLabel?: string;
  file?: string;
};

// One markup shape, used everywhere: language label plus the source file
// where known plus a copy button over the escaped block text. Untagged
// fences read as `text`.
export function codeBlockFigure(
  lang: string | undefined,
  code: string,
  header: CodeBlockHeader = {},
): string {
  const shown = lang && lang.length > 0 ? lang : "text";
  const langLabel = header.langLabel ?? shown;
  const fileLabel = header.file;
  const copyLabel = header.copyLabel ?? "Copy code block";
  return [
    `<figure class="codeblock" data-lang="${escapeHtml(shown)}">`,
    `  <div class="codeblock-bar">`,
    `    <span class="codeblock-lang">${escapeHtml(langLabel)}</span>`,
    ...(fileLabel ? [`    <span class="codeblock-file">${escapeHtml(fileLabel)}</span>`] : []),
    `    <button class="codeblock-copy" type="button" aria-label="${escapeHtml(copyLabel)}">Copy</button>`,
    `  </div>`,
    `  <pre><code>${escapeHtml(code)}</code></pre>`,
    `</figure>`,
  ].join("\n");
}

export const codeBlockExtension: MarkdownExtension = {
  name: "codeblock",
  renderHtml(node) {
    if (node.type === "code") {
      const file = fileFromMeta(node.meta);
      if (isPromptFence(node)) {
        return codeBlockFigure(node.lang, node.value, {
          copyLabel: PROMPT_COPY_LABEL,
          langLabel: PROMPT_LANG_LABEL,
          file: file ?? PROMPT_SOURCE_FILE,
        });
      }
      return codeBlockFigure(node.lang, node.value, { file });
    }
    return undefined;
  },
};

// The one place the prompt header lives: assembly calls this for the
// embedded prompt figure instead of composing it by hand.
export function promptFigure(prompt: string): string {
  return codeBlockFigure("text", prompt, {
    copyLabel: PROMPT_COPY_LABEL,
    langLabel: PROMPT_LANG_LABEL,
    file: PROMPT_SOURCE_FILE,
  });
}

// Wired once per page by the shell: click copies the sibling `<code>` text,
// the button confirms inline and reverts, and the polite live region
// announces the outcome. Command blocks (`$ sprout …` on every line) copy
// without the leading `$`, so pasting runs. Without a clipboard API the
// text is selected instead, and the label says so rather than failing
// silently.
export const codeBlockScript = `(() => {
  const status = document.querySelector(".codeblock-status");
  function announce(message) {
    if (status) status.textContent = message;
  }
  function copyValue(value) {
    const lines = value.split("\\n");
    const commands = lines.filter((line) => line.trim().length > 0);
    if (commands.length > 0 && commands.every((line) => line.trimStart().startsWith("$ "))) {
      return lines.map((line) => line.replace(/^\\s*\\$\\s?/, "")).join("\\n");
    }
    return value;
  }
  function settle(button, fallback, label, message) {
    button.textContent = label;
    button.classList.add("done");
    announce(message);
    window.setTimeout(() => {
      button.textContent = fallback;
      button.classList.remove("done");
    }, 1600);
  }
  function select(code) {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  document.querySelectorAll("button.codeblock-copy").forEach((button) => {
    const figure = button.closest("figure.codeblock");
    const code = figure ? figure.querySelector("pre > code") : null;
    if (!code) return;
    const fallback = button.textContent || "Copy";
    button.addEventListener("blur", () => {
      button.textContent = fallback;
      button.classList.remove("done");
    });
    button.addEventListener("click", async () => {
      const value = copyValue(code.textContent || "");
      try {
        if (!navigator.clipboard) throw new Error("no clipboard");
        await navigator.clipboard.writeText(value);
        settle(button, fallback, "copied", "Code block copied");
      } catch {
        select(code);
        settle(button, fallback, "selected", "Clipboard unavailable; code block selected, copy it manually");
      }
    });
  });
})();`;
