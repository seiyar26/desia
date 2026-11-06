declare module "essentia.js/dist/essentia-wasm.es.js" {
  export const EssentiaWASM: unknown;
}

declare module "essentia.js/dist/essentia.js-core.es.js" {
  type Vector = { delete?: () => void };
  export default class Essentia {
    constructor(wasm: unknown, isDebug?: boolean);
    arrayToVector(input: Float32Array): Vector;
    RhythmExtractor2013(
      signal: Vector,
      maxTempo?: number,
      method?: string,
      minTempo?: number,
    ): { bpm: number; confidence: number; ticks: Vector; estimates: Vector; bpmIntervals: Vector };
    KeyExtractor(signal: Vector): { key: string; scale: string; strength: number };
    LoudnessEBUR128(
      left: Vector,
      right: Vector,
      hopSize?: number,
      sampleRate?: number,
      startAtZero?: boolean,
    ): {
      integratedLoudness: number;
      loudnessRange: number;
      momentaryLoudness: Vector;
      shortTermLoudness: Vector;
    };
    DynamicComplexity(
      signal: Vector,
      frameSize?: number,
      sampleRate?: number,
    ): { dynamicComplexity: number; loudness: number };
  }
}
