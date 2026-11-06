/// <reference lib="webworker" />
import { EssentiaWASM } from "essentia.js/dist/essentia-wasm.es.js";
import Essentia from "essentia.js/dist/essentia.js-core.es.js";
import type { Analysis, AnalysisRequest, AnalysisResponse } from "./analysis";

let essentia: Essentia | null = null;

const free = (...vectors: ({ delete?: () => void } | undefined)[]) => {
  for (const v of vectors) v?.delete?.();
};

function analyze({ left, right, sampleRate }: AnalysisRequest): Analysis {
  essentia ??= new Essentia(EssentiaWASM);
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) * 0.5;

  const vMono = essentia.arrayToVector(mono);
  const vLeft = essentia.arrayToVector(left);
  const vRight = essentia.arrayToVector(right);
  try {
    const rhythm = essentia.RhythmExtractor2013(vMono, 208, "degara", 40);
    free(rhythm.ticks, rhythm.estimates, rhythm.bpmIntervals);
    const key = essentia.KeyExtractor(vMono);
    const loud = essentia.LoudnessEBUR128(vLeft, vRight, 0.1, sampleRate, false);
    free(loud.momentaryLoudness, loud.shortTermLoudness);
    const dyn = essentia.DynamicComplexity(vMono, 0.2, sampleRate);
    return {
      bpm: rhythm.bpm,
      key: key.key,
      scale: key.scale,
      keyStrength: key.strength,
      lufs: loud.integratedLoudness,
      lra: loud.loudnessRange,
      dynamic: dyn.dynamicComplexity,
    };
  } finally {
    free(vMono, vLeft, vRight);
  }
}

self.onmessage = (e: MessageEvent<AnalysisRequest & { id: number }>) => {
  const { id } = e.data;
  let response: AnalysisResponse;
  try {
    response = { id, ok: true, analysis: analyze(e.data) };
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  (self as DedicatedWorkerGlobalScope).postMessage(response);
};
