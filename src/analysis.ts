export type Analysis = {
  bpm: number;
  key: string;
  scale: string;
  keyStrength: number;
  lufs: number;
  lra: number;
  dynamic: number;
};

export type AnalysisRequest = { left: Float32Array; right: Float32Array; sampleRate: number };

export type AnalysisResponse =
  | { id: number; ok: true; analysis: Analysis }
  | { id: number; ok: false; error: string };

// Les algorithmes Essentia (tempo, tonalité) sont calibrés pour 44,1 kHz.
const ANALYSIS_RATE = 44100;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (a: Analysis) => void; reject: (e: Error) => void }>();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
    const job = pending.get(e.data.id);
    if (!job) return;
    pending.delete(e.data.id);
    if (e.data.ok) job.resolve(e.data.analysis);
    else job.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    for (const job of pending.values()) job.reject(new Error(e.message || "Analyse impossible"));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

async function toStereo44k(buffer: AudioBuffer) {
  const length = Math.ceil(buffer.duration * ANALYSIS_RATE);
  const ctx = new OfflineAudioContext(2, length, ANALYSIS_RATE);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  const rendered = await ctx.startRendering();
  return { left: rendered.getChannelData(0).slice(), right: rendered.getChannelData(1).slice() };
}

export async function analyzeBuffer(buffer: AudioBuffer): Promise<Analysis> {
  const { left, right } = await toStereo44k(buffer);
  const id = nextId++;
  return new Promise<Analysis>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, left, right, sampleRate: ANALYSIS_RATE }, [left.buffer, right.buffer]);
  });
}

const NOTE_FR: Record<string, string> = {
  C: "Do",
  "C#": "Do♯",
  Db: "Ré♭",
  D: "Ré",
  "D#": "Ré♯",
  Eb: "Mi♭",
  E: "Mi",
  F: "Fa",
  "F#": "Fa♯",
  Gb: "Sol♭",
  G: "Sol",
  "G#": "Sol♯",
  Ab: "La♭",
  A: "La",
  "A#": "La♯",
  Bb: "Si♭",
  B: "Si",
};

export const keyLabel = (a: Analysis) =>
  `${NOTE_FR[a.key] ?? a.key} ${a.scale === "major" ? "majeur" : "mineur"}`;
