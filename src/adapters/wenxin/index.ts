// Wenxin adapter: inject a "save with metadata" button onto each generated
// image in the current conversation.
//
// Layout, in priority order:
//  Plan A — float the button OUTSIDE the image block's top edge (top:-32px)
//    so hovering never enters _final-image. Requires 32px of clearance past
//    every clipping ancestor.
//  Plan B — insert a toolbar row AFTER the outermost side-by-side layout
//    ancestor of the image (a flex row / grid / inline group). The toolbar is
//    a normal-flow block, so it can never be clipped by the image row nor
//    become a stray flex item (the failure mode when inserting inside the row).

import {
  WENXIN_SELECTORS,
  extractPrompt,
  isInsideHistory,
} from "./dom";
import type { GenerationMeta } from "../../core/types";

const BTN_FLAG = "data-aip-saver-btn";
const BTN_CLASS = "aip-saver-btn";
const TOOLBAR_FLAG = "data-aip-toolbar";
const MODEL = "wenxin-assistant";
const TOOL = "AI-Image-Prompt-Saver";
const TOOL_VERSION = "0.1.0";
const DEBOUNCE_MS = 500;

const MAX_Z_INDEX = "2147483647";
const BTN_ABOVE_TOP_PX = 32; // button sits fully above the block's top edge
const DEFAULT_LABEL = "💾 保存";

// block -> its live button (survives rescan; re-injects when React detaches it)
const injected = new WeakMap<HTMLElement, HTMLButtonElement>();

export function initWenxinAdapter(): void {
  scanAndInject();
  observeDom();
}

function scanAndInject(): void {
  const blocks = Array.from(
    document.querySelectorAll<HTMLElement>(WENXIN_SELECTORS.imageBlock)
  ).filter(
    (block) =>
      !isInsideHistory(block) && !!block.getAttribute("data-image-url")
  );

  // Group blocks by their shared grid/row container so a 4-up row gets ONE
  // toolbar with labeled buttons, instead of one fragile toolbar per cell.
  const groups = new Map<HTMLElement, HTMLElement[]>();
  const singles: HTMLElement[] = [];
  for (const block of blocks) {
    const row = findRowContainer(block);
    if (row) {
      const members = groups.get(row);
      if (members) members.push(block);
      else groups.set(row, [block]);
    } else {
      singles.push(block);
    }
  }

  for (const [row, members] of groups) injectGroupToolbar(row, members);
  for (const block of singles) injectSingle(block);
}

// Nearest ancestor that contains 2+ image blocks — the visual row/grid.
function findRowContainer(block: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = block.parentElement;
  while (node && node !== document.body) {
    if (node.querySelectorAll(WENXIN_SELECTORS.imageBlock).length >= 2) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function isLive(block: HTMLElement): boolean {
  const btn = injected.get(block);
  return !!btn && btn.isConnected;
}

function injectSingle(block: HTMLElement): void {
  if (isLive(block)) return;

  if (canPlaceAbove(block)) {
    if (getComputedStyle(block).position === "static") {
      block.style.position = "relative";
    }
    const btn = createButton(block, DEFAULT_LABEL);
    btn.style.position = "absolute";
    btn.style.top = `-${BTN_ABOVE_TOP_PX}px`;
    btn.style.right = "8px";
    btn.style.zIndex = MAX_Z_INDEX;
    block.appendChild(btn);
    injected.set(block, btn);
    return;
  }

  const anchor = findRowAnchor(block);
  const toolbar = ensureToolbarAfter(anchor);
  appendToolbarButton(toolbar, block, DEFAULT_LABEL);
}

function injectGroupToolbar(row: HTMLElement, members: HTMLElement[]): void {
  const pending = members.filter((m) => !isLive(m));
  if (!pending.length) return;
  const peers = Array.from(
    row.querySelectorAll(WENXIN_SELECTORS.imageBlock)
  ) as HTMLElement[];
  const toolbar = ensureToolbarAfter(row);
  alignToolbarToRow(toolbar, row, peers.length);
  for (const block of pending) {
    const idx = peers.indexOf(block);
    const label =
      peers.length > 1 && idx >= 0 ? `💾 保存 图${idx + 1}` : DEFAULT_LABEL;
    appendToolbarButton(toolbar, block, label);
  }
}

// Mirror the image row's column layout so each button sits directly under
// its image: copy the grid template when the row is a grid, otherwise assume
// equal-width flex children (which Wenxin's image rows are).
function alignToolbarToRow(
  toolbar: HTMLElement,
  row: HTMLElement,
  columns: number
): void {
  const style = getComputedStyle(row);
  const isGrid = style.display.includes("grid");
  toolbar.style.display = "grid";
  toolbar.style.gridTemplateColumns =
    isGrid && style.gridTemplateColumns !== "none"
      ? style.gridTemplateColumns
      : `repeat(${columns}, minmax(0, 1fr))`;
  toolbar.style.columnGap = style.columnGap;
  toolbar.style.paddingLeft = style.paddingLeft;
  toolbar.style.paddingRight = style.paddingRight;
}

// Toolbar is a normal-flow block sibling placed after the whole row, so no
// clipping/flex parent can hide it.
function ensureToolbarAfter(anchor: HTMLElement): HTMLElement {
  const next = anchor.nextElementSibling as HTMLElement | null;
  if (next && next.hasAttribute(TOOLBAR_FLAG)) return next;
  const toolbar = document.createElement("div");
  toolbar.setAttribute(TOOLBAR_FLAG, "1");
  toolbar.style.display = "flex";
  toolbar.style.flexWrap = "wrap";
  toolbar.style.gap = "8px";
  toolbar.style.marginTop = "6px";
  anchor.insertAdjacentElement("afterend", toolbar);
  return toolbar;
}

function appendToolbarButton(
  toolbar: HTMLElement,
  block: HTMLElement,
  label: string
): void {
  // React may replace the block element (losing the WeakMap entry) while the
  // toolbar survives; dedupe by image URL as a second guard.
  const url = block.getAttribute("data-image-url") || "";
  const dup = Array.from(
    toolbar.querySelectorAll<HTMLButtonElement>(`[${BTN_FLAG}]`)
  ).find((b) => b.dataset.aipUrl === url);
  if (dup && dup.isConnected) {
    injected.set(block, dup);
    return;
  }
  const btn = createButton(block, label);
  toolbar.appendChild(btn);
  injected.set(block, btn);
}

// Climb while the PARENT lays its children out side-by-side; the returned
// node is the outermost element of that horizontal group. Inserting a
// toolbar after it lands in normal vertical flow.
function findRowAnchor(block: HTMLElement): HTMLElement {
  let node: HTMLElement = block;
  let parent: HTMLElement | null = block.parentElement;
  while (parent && laysOutSideBySide(parent, node)) {
    node = parent;
    parent = parent.parentElement;
  }
  return node;
}

function laysOutSideBySide(parent: HTMLElement, node: HTMLElement): boolean {
  const style = getComputedStyle(parent);
  const disp = style.display;
  if (disp.includes("grid")) return true;
  if (disp.includes("flex") && !style.flexDirection.startsWith("column")) {
    return true;
  }
  if (
    (disp === "inline" || disp === "inline-block") &&
    node.querySelectorAll(WENXIN_SELECTORS.imageBlock).length > 1
  ) {
    return true;
  }
  return false;
}

// Plan A viability: BTN_ABOVE_TOP_PX clearance between the block's top edge
// and every ancestor that clips overflow.
function canPlaceAbove(block: HTMLElement): boolean {
  const rect = block.getBoundingClientRect();
  let node: HTMLElement | null = block.parentElement;
  while (node && node !== document.documentElement) {
    const style = getComputedStyle(node);
    const clips =
      style.overflowX !== "visible" || style.overflowY !== "visible";
    if (clips) {
      const clipTop = node.getBoundingClientRect().top;
      if (rect.top - BTN_ABOVE_TOP_PX < clipTop) return false;
    }
    node = node.parentElement;
  }
  return true;
}

function createButton(
  block: HTMLElement,
  label: string
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute(BTN_FLAG, "1");
  btn.className = BTN_CLASS;
  btn.textContent = label;
  btn.dataset.aipLabel = label;
  btn.dataset.aipUrl = block.getAttribute("data-image-url") || "";
  applyBaseStyle(btn);
  blockHoverGuards(btn);
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void onSaveClick(block, btn);
  });
  return btn;
}

function applyBaseStyle(btn: HTMLElement): void {
  btn.style.pointerEvents = "auto";
  btn.style.padding = "4px 10px";
  btn.style.border = "none";
  btn.style.borderRadius = "6px";
  btn.style.cursor = "pointer";
  btn.style.font = "13px/1.2 system-ui, sans-serif";
  btn.style.color = "#fff";
  btn.style.background = "rgba(0,0,0,0.55)";
  btn.style.opacity = "0.9";
  btn.style.whiteSpace = "nowrap";
  btn.style.transition = "opacity 120ms ease, background 120ms ease";
  btn.addEventListener("mouseenter", () => {
    btn.style.opacity = "1";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.opacity = "0.9";
  });
}

// Keep mouse events from reaching the site's own handlers (its menu is
// pre-rendered, but its JS may track mouseover/mousemove on ancestors).
function blockHoverGuards(btn: HTMLElement): void {
  const guarded = ["mouseenter", "mouseover", "mousemove"] as const;
  for (const type of guarded) {
    btn.addEventListener(type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  }
}

function setButtonState(btn: HTMLElement, text: string, bg: string): void {
  btn.textContent = text;
  btn.style.background = bg;
}

async function onSaveClick(
  block: HTMLElement,
  btn: HTMLElement
): Promise<void> {
  const imageUrl = block.getAttribute("data-image-url");
  if (!imageUrl) {
    setButtonState(btn, "无图片", "rgba(180,60,60,0.85)");
    resetButtonLater(btn);
    return;
  }

  const prompt = extractPrompt(block);
  const meta: GenerationMeta = {
    prompt,
    model: MODEL,
    source: MODEL,
    imageUrl,
    imageType: block.getAttribute("data-image-type") || undefined,
    createdAt: new Date().toISOString(),
    tool: TOOL,
    toolVersion: TOOL_VERSION,
  };

  setButtonState(btn, "保存中…", "rgba(40,90,180,0.85)");
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "SAVE_IMAGE_WITH_META",
      imageUrl,
      meta,
    });
    if (resp && resp.ok) {
      if (prompt) {
        setButtonState(btn, "✓ 已保存", "rgba(40,150,80,0.9)");
      } else {
        // Metadata was written but the prompt came out empty — surface it
        // at click time instead of letting the user discover it in exif.
        setButtonState(btn, "⚠ 已存·无提示词", "rgba(200,140,30,0.9)");
      }
    } else {
      const reason = resp && resp.error ? resp.error : "未知错误";
      console.warn("[AI-Image-Prompt-Saver] save rejected:", reason);
      setButtonState(btn, "✗ 失败", "rgba(180,60,60,0.85)");
    }
  } catch (err) {
    console.error("[AI-Image-Prompt-Saver] sendMessage failed", err);
    setButtonState(btn, "✗ 失败", "rgba(180,60,60,0.85)");
  }
  resetButtonLater(btn);
}

function resetButtonLater(btn: HTMLElement): void {
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.textContent = btn.dataset.aipLabel || DEFAULT_LABEL;
    btn.style.background = "rgba(0,0,0,0.55)";
  }, 1600);
}

// Watch the DOM so buttons appear on lazily-loaded images too. All mutations
// funnel through one debounced rescan to avoid mid-insert thrash.
function observeDom(): void {
  let timer: number | undefined;
  const observer = new MutationObserver(() => {
    if (timer !== undefined) return; // already scheduled
    timer = window.setTimeout(() => {
      timer = undefined;
      scanAndInject();
    }, DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
