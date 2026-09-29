// Viewer page: open a local JPEG/PNG, show the metadata this extension
// embedded, copy the prompt, or export a metadata-stripped copy.

import {
  detectFormat,
  readJpegMetadata,
  readMetadata,
  stripMetadata,
} from "../core/metadata";
import type { MetaEntries } from "../core/types";

let currentBytes: Uint8Array | null = null;
let currentName = "";
let previewUrl = "";

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node;
}

function setDisplay(id: string, visible: boolean): void {
  el(id).style.display = visible ? "" : "none";
}

async function loadFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  currentBytes = bytes;
  currentName = file.name;

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  const img = el("preview") as HTMLImageElement;
  img.src = previewUrl;
  img.style.display = "block";
  el("placeholder").style.display = "none";
  el("file-name").textContent = file.name;

  renderMeta();
}

function renderMeta(): void {
  const bytes = currentBytes;
  if (!bytes) return;

  let format: "png" | "jpeg" | null;
  try {
    format = detectFormat(bytes);
  } catch {
    format = null;
  }

  let entries: MetaEntries = {};
  if (format) {
    try {
      entries = readMetadata(bytes);
    } catch {
      entries = {};
    }
  }
  const hasMeta = Object.keys(entries).length > 0;

  setDisplay("meta-unsupported", !format);
  setDisplay("meta-empty", !!format && !hasMeta);
  setDisplay("meta-found", hasMeta);
  setDisplay("meta-info", hasMeta);
  setDisplay("meta-actions", hasMeta);
  (el("prompt-box") as HTMLTextAreaElement).value = entries.AIP_PROMPT || "";
  if (!format || !hasMeta) return;

  el("prompt-text").textContent = entries.AIP_PROMPT || "（无提示词）";
  el("model-val").textContent = entries.AIP_MODEL || "—";

  const w = entries.AIP_WIDTH;
  const h = entries.AIP_HEIGHT;
  if (w && h) {
    el("size-val").textContent = `${w} × ${h}`;
  } else {
    const img = el("preview") as HTMLImageElement;
    const fill = () => {
      if (img.naturalWidth) {
        el("size-val").textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
      }
    };
    if (img.complete) fill();
    else img.addEventListener("load", fill, { once: true });
  }

  const created = entries.AIP_CREATED_AT;
  el("time-val").textContent = created
    ? new Date(created).toLocaleString("zh-CN")
    : "—";
  el("source-val").textContent = entries.AIP_IMAGE_URL || "—";

  const raw =
    format === "jpeg"
      ? readJpegMetadata(bytes)
      : JSON.stringify(entries, null, 2);
  el("raw-json").textContent = raw;
}

function onCopy(): void {
  const text = readMetadataSafe().AIP_PROMPT || "";
  if (!text) return;
  copyText(text, el("copy-btn"), "复制提示词");
}

// Copies the CURRENT textarea content, so edits made in the box are kept.
function onCopyBox(): void {
  const box = el("prompt-box") as HTMLTextAreaElement;
  const text = box.value.trim();
  if (!text) return;
  copyText(text, el("copy-box-btn"), "📋 一键复制提示词");
}

function copyText(text: string, btn: HTMLElement, restoreLabel: string): void {
  navigator.clipboard.writeText(text).then(
    () => {
      btn.textContent = "✓ 已复制";
      setTimeout(() => (btn.textContent = restoreLabel), 1500);
    },
    (err) => console.warn("copy failed", err)
  );
}

function readMetadataSafe(): MetaEntries {
  try {
    return currentBytes ? readMetadata(currentBytes) : {};
  } catch {
    return {};
  }
}

function onStrip(): void {
  if (!currentBytes) return;
  let stripped: Uint8Array;
  try {
    stripped = stripMetadata(currentBytes);
  } catch (err) {
    alert(`删除元数据失败：${String(err)}`);
    return;
  }
  const mime = detectFormat(stripped) === "png" ? "image/png" : "image/jpeg";
  const ext = mime === "image/png" ? ".png" : ".jpg";
  const base = currentName.replace(/\.[^.]+$/, "");
  const url = URL.createObjectURL(new Blob([stripped.slice()], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${base}-无元数据${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function init(): void {
  const fileInput = el("file-input") as HTMLInputElement;
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void loadFile(file);
    fileInput.value = "";
  });

  el("copy-btn").addEventListener("click", onCopy);
  el("copy-box-btn").addEventListener("click", onCopyBox);
  el("strip-btn").addEventListener("click", onStrip);

  const rawToggle = el("raw-toggle");
  rawToggle.addEventListener("click", () => {
    const pre = el("raw-json");
    const shown = pre.style.display === "block";
    pre.style.display = shown ? "none" : "block";
    rawToggle.textContent = shown ? "显示原始 JSON" : "隐藏原始 JSON";
  });

  document.addEventListener("dragover", (event) => {
    event.preventDefault();
    document.body.classList.add("dragging");
  });
  document.addEventListener("dragleave", () => {
    document.body.classList.remove("dragging");
  });
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    document.body.classList.remove("dragging");
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file);
  });
}

init();
