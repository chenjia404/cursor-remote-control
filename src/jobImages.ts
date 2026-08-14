import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { SDKImage } from "@cursor/sdk";
import { config } from "./config.js";

export const MAX_JOB_IMAGES = 4;
export const MAX_JOB_IMAGE_BYTES = 4 * 1024 * 1024;

export type JobImageMeta = {
  id: string;
  mimeType: string;
  byteLength: number;
};

const IMAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertSafeId(id: string): string {
  if (!IMAGE_ID_PATTERN.test(id)) throw new Error("图片标识无效");
  return id;
}

function imagesRoot(): string {
  return path.join(config.dataDir, "job-images");
}

function jobImageDir(jobId: string): string {
  return path.join(imagesRoot(), assertSafeId(jobId));
}

function jobImagePath(jobId: string, imageId: string): string {
  return path.join(jobImageDir(jobId), assertSafeId(imageId));
}

function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii") === "GIF87a") {
    return "image/gif";
  }
  if (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function decodeImageData(raw: unknown): Buffer {
  const text = String(raw || "").trim();
  const comma = text.indexOf(",");
  const payload = text.startsWith("data:") && comma >= 0 ? text.slice(comma + 1) : text;
  if (!payload || payload.length > MAX_JOB_IMAGE_BYTES * 2) {
    throw new Error("图片内容过大或无效");
  }

  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) throw new Error("图片内容无效");
  if (buffer.length > MAX_JOB_IMAGE_BYTES) throw new Error("单张图片不能超过 4MB");
  return buffer;
}

export async function saveJobImages(jobId: string, input: unknown): Promise<JobImageMeta[]> {
  if (!Array.isArray(input) || input.length === 0) return [];
  if (input.length > MAX_JOB_IMAGES) throw new Error(`最多附加 ${MAX_JOB_IMAGES} 张图片`);

  const pending: Array<{ meta: JobImageMeta; buffer: Buffer }> = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const buffer = decodeImageData((item as { data?: unknown }).data);
    const mimeType = sniffMimeType(buffer);
    if (!mimeType) throw new Error("仅支持 JPEG、PNG、GIF、WebP 图片");
    pending.push({
      buffer,
      meta: {
        id: crypto.randomUUID(),
        mimeType,
        byteLength: buffer.length,
      },
    });
  }

  if (!pending.length) return [];
  await fs.mkdir(jobImageDir(jobId), { recursive: true });
  for (const item of pending) {
    await fs.writeFile(jobImagePath(jobId, item.meta.id), item.buffer);
  }
  return pending.map((item) => item.meta);
}

export async function loadJobImagesForSdk(jobId: string, images: JobImageMeta[] | undefined): Promise<SDKImage[]> {
  const result: SDKImage[] = [];
  for (const image of images ?? []) {
    try {
      const buffer = await fs.readFile(jobImagePath(jobId, image.id));
      result.push({
        data: buffer.toString("base64"),
        mimeType: image.mimeType,
      });
    } catch {
      // 历史任务若缺文件，跳过该图继续执行
    }
  }
  return result;
}

export async function readJobImage(
  jobId: string,
  imageId: string,
): Promise<{ mimeType: string; buffer: Buffer } | null> {
  if (!IMAGE_ID_PATTERN.test(jobId) || !IMAGE_ID_PATTERN.test(imageId)) return null;
  const filePath = jobImagePath(jobId, imageId);
  try {
    const buffer = await fs.readFile(filePath);
    const mimeType = sniffMimeType(buffer) || "application/octet-stream";
    return { mimeType, buffer };
  } catch {
    return null;
  }
}
