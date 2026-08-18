import { config } from "./config.js";

export const MAX_TRANSCRIBE_AUDIO_BYTES = 2 * 1024 * 1024;

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export function isTranscribeConfigured(): boolean {
  return Boolean(config.transcribeApiKey);
}

export function publicVoiceCapabilities(): { transcribe: boolean } {
  return { transcribe: isTranscribeConfigured() };
}

function sniffAudioMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "audio/webm";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS") {
    return "audio/ogg";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "audio/wav";
  }
  const head = buffer.subarray(0, Math.min(buffer.length, 64));
  for (let offset = 0; offset + 8 <= head.length; offset += 1) {
    if (head.subarray(offset + 4, offset + 8).toString("ascii") === "ftyp") {
      return "audio/mp4";
    }
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "ID3") {
    return "audio/mpeg";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  return null;
}

function decodeAudioData(raw: unknown): Buffer {
  const text = String(raw || "").trim();
  const comma = text.indexOf(",");
  const payload = text.startsWith("data:") && comma >= 0 ? text.slice(comma + 1) : text;
  if (!payload || payload.length > MAX_TRANSCRIBE_AUDIO_BYTES * 2) {
    throw new Error("录音内容过大或无效");
  }

  const buffer = Buffer.from(payload, "base64");
  if (!buffer.length) throw new Error("录音内容无效");
  if (buffer.length > MAX_TRANSCRIBE_AUDIO_BYTES) throw new Error("录音不能超过 2MB");
  return buffer;
}

export function decodeTranscribeAudio(raw: unknown): { buffer: Buffer; mimeType: string } {
  const buffer = decodeAudioData(raw);
  const mimeType = sniffAudioMimeType(buffer);
  if (!mimeType || !AUDIO_EXTENSIONS[mimeType]) {
    throw new Error("不支持的音频格式");
  }
  return { buffer, mimeType };
}

function whisperLanguage(locale: string | undefined): "zh" | "en" | undefined {
  if (locale === "en" || locale === "en-US") return "en";
  if (locale === "zh" || locale === "zh-CN") return "zh";
  return undefined;
}

export async function transcribeAudio(input: {
  data: unknown;
  language?: string;
}): Promise<string> {
  if (!isTranscribeConfigured()) {
    throw new Error("未配置语音转写");
  }

  const { buffer, mimeType } = decodeTranscribeAudio(input.data);
  const filename = `audio.${AUDIO_EXTENSIONS[mimeType]}`;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
  form.append("model", config.transcribeModel);
  const language = whisperLanguage(input.language);
  if (language) form.append("language", language);

  let response: Response;
  try {
    response = await fetch(`${config.transcribeBaseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.transcribeApiKey}`,
      },
      body: form,
    });
  } catch {
    throw new Error("语音转写失败");
  }

  if (!response.ok) {
    console.warn(`语音转写上游返回 ${response.status}`);
    throw new Error("语音转写失败");
  }

  const payload = (await response.json()) as { text?: unknown };
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  return text;
}
