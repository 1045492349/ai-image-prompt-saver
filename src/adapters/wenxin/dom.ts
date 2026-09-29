// Wenxin assistant DOM helpers.
// Selectors use attribute/substring matching because the CSS module suffix
// (e.g. `_zs537_149`) is a build hash that changes between deployments.
//
// Verified on the live page (2026-09-28):
//  - image blocks sit under `... ai-entry-block ai-image-generate ->
//    answer-container -> chat-search-answer-generate-item -> cs-answer-container`
//  - the user's prompt text is NOT in the light DOM; the page has shadow-root
//    hosts, so every query below pierces shadow boundaries.

export const WENXIN_SELECTORS = {
  imageBlock: "[data-image-url]",
  imageInner: '[class*="image-visible"]',
  chatMessage: '[class*="marklang-paragraph"]',
  historyItem: '[class*="history-item-text"]',
  answerContainer: '[class*="answer-container"]',
  askContainer: '[class*="ask-container"], [class*="question"]',
} as const;

// querySelectorAll that recursively pierces every open shadow root.
export function deepQueryAll(
  selector: string,
  root: ParentNode = document
): Element[] {
  const out: Element[] = [];
  const collect = (r: ParentNode) => {
    out.push(...Array.from(r.querySelectorAll(selector)));
    for (const el of Array.from(r.querySelectorAll("*"))) {
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) collect(sr);
    }
  };
  collect(root);
  return out;
}

// True if `el` (or any ancestor) lives inside the history sidebar.
// Shadow-scoped nodes can never be inside the light-DOM sidebar, so the
// closest() check degrades safely for them.
export function isInsideHistory(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.matches && node.matches(WENXIN_SELECTORS.historyItem)) return true;
    const root = node.getRootNode();
    node =
      root instanceof ShadowRoot
        ? (root.host as Element)
        : node.parentElement;
  }
  return false;
}

// From an arbitrary element (e.g. an injected button), walk up to the nearest
// generated-image block that belongs to the *current* conversation, never the
// history sidebar. Returns null if no such block exists.
export function findCurrentImageBlock(el: Element): Element | null {
  let node: Element | null = el;
  while (node && node !== document.documentElement) {
    if (
      node.matches &&
      node.matches(WENXIN_SELECTORS.imageBlock) &&
      node.getAttribute("data-image-url") &&
      !isInsideHistory(node)
    ) {
      return node;
    }
    const root = node.getRootNode();
    node =
      root instanceof ShadowRoot ? (root.host as Element) : node.parentElement;
  }
  return null;
}

// Try to read a prompt from a container that sits BEFORE the current answer
// (typically the user's question bubble).
function promptTextFrom(container: Element): string {
  if (isInsideHistory(container)) return "";

  // Preferred: explicit prompt paragraphs inside the container.
  const paragraphs = deepQueryAll(
    WENXIN_SELECTORS.chatMessage,
    container
  ).filter((n) => !isInsideHistory(n));
  if (paragraphs.length) {
    const text = cleanText(paragraphs[paragraphs.length - 1].textContent);
    if (text) return text;
  }

  // Fallback: a question/ask container's raw text — but only when the
  // container itself holds no images (otherwise we'd grab UI noise).
  const holdsImages =
    container.matches(WENXIN_SELECTORS.imageBlock) ||
    deepQueryAll(WENXIN_SELECTORS.imageBlock, container).length > 0;
  if (!holdsImages) {
    const ask =
      deepQueryAll(WENXIN_SELECTORS.askContainer, container)[0] ??
      (container.matches(WENXIN_SELECTORS.askContainer) ? container : null);
    if (ask) {
      const text = cleanText(ask.textContent);
      if (text) return text;
    }
  }
  return "";
}

// Level 1: climb from the image's answer container upward; at each level,
// inspect previous siblings (nearest first) for the user's prompt.
function extractPromptLevel1(imageBlock: Element): string {
  let node: Element | null =
    imageBlock.closest(WENXIN_SELECTORS.answerContainer) ?? imageBlock;
  while (node && node !== document.documentElement) {
    let sib: Element | null = node.previousElementSibling;
    while (sib) {
      const text = promptTextFrom(sib);
      if (text) return text;
      sib = sib.previousElementSibling;
    }
    const root = node.getRootNode();
    node =
      root instanceof ShadowRoot ? (root.host as Element) : node.parentElement;
  }
  return "";
}

// Level 2: longest prompt paragraph anywhere in the current conversation
// (light DOM + shadow roots; history excluded). Prompts are long; the
// assistant's pleasantries are short.
function extractPromptLevel2(): string {
  const paragraphs = deepQueryAll(WENXIN_SELECTORS.chatMessage).filter(
    (n) => !isInsideHistory(n)
  );
  let best = "";
  for (const p of paragraphs) {
    const text = cleanText(p.textContent);
    if (text.length > best.length) best = text;
  }
  return best;
}

// Level 3: longest text among question/ask containers (image-free,
// history-excluded). Catches prompts rendered by components that use neither
// marklang-paragraph nor the expected sibling layout.
function extractPromptLevel3(): string {
  const candidates = deepQueryAll(WENXIN_SELECTORS.askContainer).filter(
    (n) =>
      !isInsideHistory(n) &&
      deepQueryAll(WENXIN_SELECTORS.imageBlock, n).length === 0
  );
  let best = "";
  for (const c of candidates) {
    const text = cleanText(c.textContent);
    if (text.length > best.length) best = text;
  }
  return best;
}

// Multi-level prompt extraction with graceful fallback.
export function extractPrompt(imageBlock: Element): string {
  const level1 = extractPromptLevel1(imageBlock);
  if (level1) return level1;

  const level2 = extractPromptLevel2();
  if (level2) return level2;

  const level3 = extractPromptLevel3();
  if (level3) return level3;

  console.warn(
    "[AI-Image-Prompt-Saver] could not resolve prompt from current conversation"
  );
  return "";
}

function cleanText(text: string | null): string {
  return (text ?? "").replace(/\u00a0/g, " ").trim();
}
