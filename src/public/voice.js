/** 语音输入、转写与按句朗读。不依赖 app.js，由页面传入回调。 */

const MAX_RECORD_MS = 60_000;
const MAX_THINKING_SENTENCE = 300;
const MAX_ASSISTANT_CHARS = 2000;
const TOOL_I18N_KEYS = new Set([
  "shell",
  "mcp",
  "webSearch",
  "webFetch",
  "generateImage",
  "task",
  "delete",
  "edit",
  "read",
  "grep",
  "glob",
  "ls",
  "semSearch",
  "readLints",
  "updateTodos",
  "readTodos",
  "askQuestion",
  "await",
  "applyAgentDiff",
]);

let mediaStream = null;
let mediaRecorder = null;
let recordChunks = [];
let recordMimeType = "";
let recordTimer = null;
let recordStartedAt = 0;
let recording = false;
let recognizing = false;
let recognitionRef = null;
let speechUnlocked = false;
let speaking = false;
let speakQueue = [];
let seededJobId = "";
const spokenOffsets = new Map();
const spokenTools = new Set();
const skippedCodeTurns = new Set();

export function speechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function canUseWebSpeech() {
  return Boolean(speechRecognitionCtor());
}

export function canVoiceInput(serverTranscribe) {
  return Boolean(serverTranscribe) || canUseWebSpeech();
}

export function isRecording() {
  return recording || recognizing;
}

export function isSpeaking() {
  return speaking || speakQueue.length > 0;
}

export function pickRecorderMimeType() {
  const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const candidates = isApple
    ? ["audio/mp4", "audio/aac", "audio/webm;codecs=opus", "audio/webm"]
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

export function unlockSpeech() {
  if (speechUnlocked || !("speechSynthesis" in window)) return;
  try {
    const utter = new SpeechSynthesisUtterance(" ");
    utter.volume = 0;
    utter.rate = 2;
    utter.lang = "zh-CN";
    window.speechSynthesis.speak(utter);
    speechUnlocked = true;
  } catch {
    // 部分浏览器会拒绝空朗读，稍后用户手势里再试
  }
}

export async function warmupMic() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach((track) => track.stop());
}

function preferredRecorderOptions() {
  const mimeType = pickRecorderMimeType();
  return mimeType ? { mimeType } : {};
}

export async function startRecording({ onLimit } = {}) {
  if (recording) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error("unsupported");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaStream = stream;
  recordChunks = [];
  const options = preferredRecorderOptions();
  const recorder = new MediaRecorder(stream, options);
  mediaRecorder = recorder;
  recordMimeType = recorder.mimeType || options.mimeType || "audio/webm";
  recording = true;
  recordStartedAt = Date.now();

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) recordChunks.push(event.data);
  });

  try {
    recorder.start(250);
  } catch {
    recorder.start();
  }
  if (recordTimer) window.clearTimeout(recordTimer);
  recordTimer = window.setTimeout(() => {
    if (recording) onLimit?.();
  }, MAX_RECORD_MS);
}

function stopMediaTracks() {
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

export function stopRecording() {
  return new Promise((resolve, reject) => {
    if (!recording || !mediaRecorder) {
      resolve(null);
      return;
    }

    const recorder = mediaRecorder;
    const finish = () => {
      if (recordTimer) {
        window.clearTimeout(recordTimer);
        recordTimer = null;
      }
      recording = false;
      mediaRecorder = null;
      stopMediaTracks();
      const blob = new Blob(recordChunks, { type: recordMimeType || "audio/webm" });
      recordChunks = [];
      resolve(blob.size > 0 ? blob : null);
    };

    recorder.addEventListener("error", () => {
      recording = false;
      mediaRecorder = null;
      stopMediaTracks();
      reject(new Error("record-failed"));
    }, { once: true });

    recorder.addEventListener("stop", finish, { once: true });
    if (recorder.state === "recording") recorder.stop();
    else finish();
  });
}

export function cancelRecording() {
  if (recognitionRef) {
    try {
      recognitionRef.stop();
    } catch {
      // ignore
    }
    recognitionRef = null;
  }
  recognizing = false;
  if (!recording) {
    stopMediaTracks();
    return;
  }
  recording = false;
  if (recordTimer) {
    window.clearTimeout(recordTimer);
    recordTimer = null;
  }
  try {
    if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
  } catch {
    // ignore
  }
  mediaRecorder = null;
  recordChunks = [];
  stopMediaTracks();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(blob);
  });
}

export async function transcribeWithServer(blob, { postJson, language }) {
  const data = await blobToDataUrl(blob);
  const result = await postJson("/api/transcribe", {
    data,
    mimeType: blob.type || "audio/webm",
    language,
  });
  return String(result?.text || "").trim();
}

export function startWebSpeech({ language, onResult }) {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) throw new Error("unsupported");
  if (recognizing) return;

  const recognition = new Ctor();
  recognitionRef = recognition;
  recognizing = true;
  recognition.lang = language || "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onresult = (event) => {
    let finalText = "";
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const item = event.results[i];
      const piece = item[0]?.transcript || "";
      if (item.isFinal) finalText += piece;
      else interim += piece;
    }
    onResult?.({ text: `${finalText}${interim}`.trim(), isFinal: Boolean(finalText) });
  };

  recognition.onerror = (event) => {
    recognizing = false;
    recognitionRef = null;
    const err = event?.error;
    if (err === "aborted" || err === "no-speech") {
      onResult?.({ text: "", isFinal: true, ended: true });
      return;
    }
    onResult?.({ text: "", isFinal: true, error: "speech-error" });
  };

  recognition.onend = () => {
    recognizing = false;
    recognitionRef = null;
    onResult?.({ text: "", isFinal: true, ended: true });
  };

  recognition.start();
}

export function stopWebSpeech() {
  return new Promise((resolve) => {
    const recognition = recognitionRef;
    if (!recognition || !recognizing) {
      resolve("");
      return;
    }

    let settled = "";
    const previous = recognition.onresult;
    recognition.onresult = (event) => {
      previous?.(event);
      let text = "";
      for (let i = 0; i < event.results.length; i += 1) {
        text += event.results[i][0]?.transcript || "";
      }
      settled = text.trim();
    };
    recognition.onerror = () => {};
    recognition.onend = () => {
      recognizing = false;
      recognitionRef = null;
      resolve(settled);
    };
    try {
      recognition.stop();
    } catch {
      recognizing = false;
      recognitionRef = null;
      resolve(settled);
    }
  });
}

function stripForSpeech(text, maxTotal = Infinity) {
  let value = String(text || "");
  value = value.replace(/```[\s\S]*?```/g, "\n");
  const unclosed = value.lastIndexOf("```");
  if (unclosed >= 0) value = value.slice(0, unclosed);
  value = value.replace(/`[^`]+`/g, "");
  value = value.replace(/https?:\/\/\S+/gi, "");
  value = value.replace(/!\[[^\]]*\]\([^)]+\)/g, "");
  value = value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  value = value.replace(/[#*_>~]{1,}/g, " ");
  value = value.replace(/\n{3,}/g, "\n\n");
  value = value.replace(/[ \t]{2,}/g, " ").trim();
  if (value.length > maxTotal) value = value.slice(0, maxTotal);
  return value;
}

function takeSpeakable(fullText, offset, { flush = false, maxSentence = MAX_THINKING_SENTENCE } = {}) {
  const next = String(fullText || "").slice(offset);
  if (!next) return { text: "", newOffset: offset };
  const pieces = [];
  const re = /[\s\S]*?[。！？.!?\n]+/g;
  let lastEnd = 0;
  let match = re.exec(next);
  while (match) {
    pieces.push(match[0]);
    lastEnd = match.index + match[0].length;
    match = re.exec(next);
  }
  let spoken = pieces.join("");
  const rest = next.slice(lastEnd);
  if (flush && rest.trim()) {
    spoken += rest;
    lastEnd = next.length;
  } else if (rest.length > maxSentence) {
    spoken += rest.slice(0, maxSentence);
    lastEnd += maxSentence;
  }
  return { text: spoken.trim(), newOffset: offset + lastEnd };
}

function getTurns(job) {
  if (!job) return [];
  if (Array.isArray(job.turns) && job.turns.length > 0) return job.turns;
  return [
    {
      id: job.activeTurnId || job.id,
      status: job.status,
      result: job.result,
    },
  ];
}

function collectTurnText(job, turn, level) {
  const logs = job.logs || [];
  const parts = [];
  for (const log of logs) {
    if (log.level !== level) continue;
    if (log.turnId && log.turnId !== turn.id) continue;
    if (!log.turnId && turn.id !== getTurns(job)[0]?.id) continue;
    if (log.message) parts.push(log.message);
  }
  if (level === "assistant" && !parts.length && typeof turn.result === "string") {
    return turn.result;
  }
  return parts.join("");
}

function parseToolLine(text) {
  const line = String(text || "").split("\n")[0].trim();
  if (!line) return null;
  const started = line.match(/^调用\s+(\S+)/);
  if (started) return { name: started[1], phase: "start" };
  const done = line.match(/^(\S+)\s+完成/);
  if (done) return { name: done[1], phase: "done" };
  const failed = line.match(/^(\S+)\s+失败/);
  if (failed) return { name: failed[1], phase: "failed" };
  return null;
}

function toolSpeakKey(jobId, turn, log, parsed) {
  const source = log.source || `${turn.id}:${parsed.name}`;
  return `${jobId}:${source}:${parsed.phase}`;
}

function toolLabel(name, t) {
  if (TOOL_I18N_KEYS.has(name)) return t(`tool.${name}`);
  return name;
}

function toolPhrase(parsed, t) {
  const name = toolLabel(parsed.name, t);
  if (parsed.phase === "start") return t("voice.toolStart", { name });
  if (parsed.phase === "done") return t("voice.toolDone", { name });
  return t("voice.toolFailed", { name });
}

function offsetKey(jobId, turnId, role) {
  return `${jobId}:${turnId}:${role}`;
}

function pumpSpeak(lang) {
  if (speaking || !speakQueue.length || !("speechSynthesis" in window)) return;
  const item = speakQueue.shift();
  if (!item?.text) {
    pumpSpeak(lang);
    return;
  }
  speaking = true;
  const utter = new SpeechSynthesisUtterance(item.text);
  utter.lang = item.lang || lang || "zh-CN";
  utter.onend = () => {
    speaking = false;
    pumpSpeak(lang);
  };
  utter.onerror = () => {
    speaking = false;
    pumpSpeak(lang);
  };
  window.speechSynthesis.speak(utter);
}

export function enqueueSpeak(text, lang) {
  const value = String(text || "").trim();
  if (!value) return;
  speakQueue.push({ text: value, lang });
  pumpSpeak(lang);
}

export function cancelSpeech() {
  speakQueue = [];
  speaking = false;
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

export function resetSpeechTracking() {
  seededJobId = "";
  spokenOffsets.clear();
  spokenTools.clear();
  skippedCodeTurns.clear();
  cancelSpeech();
}

function seedJob(job) {
  const jobId = job.id;
  for (const turn of getTurns(job)) {
    spokenOffsets.set(offsetKey(jobId, turn.id, "thinking"), stripForSpeech(collectTurnText(job, turn, "thinking")).length);
    spokenOffsets.set(
      offsetKey(jobId, turn.id, "assistant"),
      stripForSpeech(collectTurnText(job, turn, "assistant"), MAX_ASSISTANT_CHARS).length,
    );
    for (const log of job.logs || []) {
      if (log.level !== "tool") continue;
      if (log.turnId && log.turnId !== turn.id) continue;
      const parsed = parseToolLine(log.message);
      if (!parsed) continue;
      spokenTools.add(toolSpeakKey(jobId, turn, log, parsed));
    }
  }
}

function speakRoleDelta(job, turn, role, { flush, maxTotal, maxSentence, lang }) {
  const key = offsetKey(job.id, turn.id, role);
  const raw = collectTurnText(job, turn, role);
  const cleaned = stripForSpeech(raw, maxTotal);
  const offset = spokenOffsets.get(key) || 0;
  const { text, newOffset } = takeSpeakable(cleaned, offset, { flush, maxSentence });
  spokenOffsets.set(key, newOffset);
  if (text) enqueueSpeak(text, lang);
  return { cleaned, spoke: Boolean(text) };
}

export function ingestJobSpeech(job, options = {}) {
  const { enabled, speakThinking, speakTools, speakReply, lang, t, onSkipCode } = options;
  if (!enabled || !job) return;

  if (seededJobId !== job.id) {
    seedJob(job);
    seededJobId = job.id;
    return;
  }

  for (const turn of getTurns(job)) {
    if (speakThinking) {
      const assistantStarted = Boolean(stripForSpeech(collectTurnText(job, turn, "assistant")));
      const finished = ["finished", "error", "cancelled"].includes(turn.status);
      speakRoleDelta(job, turn, "thinking", {
        flush: finished || assistantStarted,
        maxTotal: Infinity,
        maxSentence: MAX_THINKING_SENTENCE,
        lang,
      });
    }

    if (speakTools) {
      for (const log of job.logs || []) {
        if (log.level !== "tool") continue;
        if (log.turnId && log.turnId !== turn.id) continue;
        const parsed = parseToolLine(log.message);
        if (!parsed) continue;
        const key = toolSpeakKey(job.id, turn, log, parsed);
        if (spokenTools.has(key)) continue;
        spokenTools.add(key);
        enqueueSpeak(toolPhrase(parsed, t), lang);
      }
    }

    if (speakReply) {
      const finished = ["finished", "error", "cancelled"].includes(turn.status);
      const { cleaned, spoke } = speakRoleDelta(job, turn, "assistant", {
        flush: finished,
        maxTotal: MAX_ASSISTANT_CHARS,
        maxSentence: MAX_THINKING_SENTENCE,
        lang,
      });
      if (finished && !cleaned && collectTurnText(job, turn, "assistant").trim() && !skippedCodeTurns.has(turn.id)) {
        skippedCodeTurns.add(turn.id);
        onSkipCode?.();
      }
      void spoke;
    }
  }
}

export function recordElapsedMs() {
  if (!recording || !recordStartedAt) return 0;
  return Date.now() - recordStartedAt;
}
