// MV3 service worker: receives save requests, embeds metadata, downloads.

import { embedMetadata, detectFormat } from "./core/metadata";
import { metaToEntries, type GenerationMeta } from "./core/types";

interface SaveImageWithMetaMessage {
  type: "SAVE_IMAGE_WITH_META";
  imageUrl: string;
  meta: GenerationMeta;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "SAVE_IMAGE_WITH_META") return false;
  const msg = message as SaveImageWithMetaMessage;
  saveImageWithMeta(msg)
    .then(() => sendResponse({ ok: true }))
    .catch((err) => {
      console.error("[AI-Image-Prompt-Saver] save failed", err);
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    });
  // Keep the message channel open for the async sendResponse.
  return true;
});

async function saveImageWithMeta(msg: SaveImageWithMetaMessage): Promise<void> {
  const resp = await fetch(msg.imageUrl, { credentials: "include" });
  if (!resp.ok) {
    throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);
  }
  const raw = new Uint8Array(await resp.arrayBuffer());

  const meta = msg.meta;
  if (!meta.imageUrl) meta.imageUrl = msg.imageUrl;
  const entries = metaToEntries(meta);
  const withFormat = {
    ...entries,
    AIP_ORIGINAL_URL: entries.AIP_IMAGE_URL,
  };

  let finalBytes: Uint8Array;
  try {
    finalBytes = embedMetadata(raw, withFormat);
  } catch (err) {
    console.warn(
      "[AI-Image-Prompt-Saver] embed failed, saving original bytes",
      err
    );
    finalBytes = raw;
  }

  const format = safeDetectFormat(finalBytes);
  const ext = format === "png" ? "png" : "jpg";
  const filename = buildFilename(meta, ext);

  const blobUrl = blobUrlFor(finalBytes, format === "png" ? "image/png" : "image/jpeg");
  try {
    await new Promise<void>((resolve, reject) => {
      chrome.downloads.download(
        {
          url: blobUrl,
          filename,
          saveAs: false,
          conflictAction: "uniquify",
        },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        }
      );
    });
  } finally {
    revokeLater(blobUrl);
  }
}

function safeDetectFormat(bytes: Uint8Array): "png" | "jpeg" {
  try {
    return detectFormat(bytes);
  } catch {
    return "jpeg";
  }
}

function buildFilename(meta: GenerationMeta, ext: string): string {
  const stamp = (meta.createdAt || new Date().toISOString())
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const slug = sanitizeSlug(meta.source || "image");
  return `aip-${slug}-${stamp}.${ext}`;
}

function sanitizeSlug(input: string): string {
  const cleaned = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 40) || "image";
}

// MV3 service workers may lack URL.createObjectURL/Blob in some builds;
// fall back to a data: URL which chrome.downloads always accepts.
function blobUrlFor(bytes: Uint8Array, mime: string): string {
  try {
    if (typeof Blob !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL) {
      const blob = new Blob([bytes.buffer.slice(0) as ArrayBuffer], { type: mime });
      return URL.createObjectURL(blob);
    }
  } catch (err) {
    console.warn("[AI-Image-Prompt-Saver] blob url unavailable, using data url", err);
  }
  return dataUrlFor(bytes, mime);
}

function dataUrlFor(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}

function revokeLater(blobUrl: string): void {
  if (!blobUrl.startsWith("blob:")) return;
  // Give the download time to start reading, then release the object URL.
  setTimeout(() => {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch {
      /* ignore */
    }
  }, 60_000);
}
