export type Settings = {
  timingMs: number;
  shortJitterMs: number;
  pitchCents: number;
  dynDb: number;
  eqDb: number;
  exciterDb: number;
  roomDb: number;
  widthMs: number;
  sampleRate: number;
};

export const PRESETS: Record<string, Settings> = {
  discret: {
    timingMs: 3,
    shortJitterMs: 0.6,
    pitchCents: 3,
    dynDb: 0.35,
    eqDb: 1,
    exciterDb: -26,
    roomDb: -66,
    widthMs: 0.15,
    sampleRate: 48000,
  },
  standard: {
    timingMs: 8,
    shortJitterMs: 1.6,
    pitchCents: 6,
    dynDb: 0.8,
    eqDb: 1.8,
    exciterDb: -18,
    roomDb: -60,
    widthMs: 0.35,
    sampleRate: 48000,
  },
  appuye: {
    timingMs: 15,
    shortJitterMs: 3,
    pitchCents: 10,
    dynDb: 1.4,
    eqDb: 2.6,
    exciterDb: -12,
    roomDb: -55,
    widthMs: 0.6,
    sampleRate: 48000,
  },
};

const EQ_BANDS = [6400, 8600, 11200, 14600, 18200];

type Layer = { pts: Float32Array; step: number; amp: number };

// Écart de vitesse maximal d'une couche : ±10 cents. Pente max d'une couche
// (pas aléatoire 0,6·amp, smoothstep ×1,5) = 0,9·amp/step, d'où un pas minimal.
const MAX_SPEED_DEV = 2 ** (10 / 1200) - 1;

function makeLayer(len: number, sr: number, ampMs: number, periodMs: number): Layer {
  const amp = (ampMs / 1000) * sr;
  const step = Math.max(1, Math.round((periodMs / 1000) * sr), Math.ceil((0.9 * amp) / MAX_SPEED_DEV));
  const count = Math.ceil(len / step) + 3;
  const pts = new Float32Array(count);
  let value = 0;
  for (let i = 0; i < count; i++) {
    value += (Math.random() * 2 - 1) * amp * 0.6;
    value = Math.max(-amp, Math.min(amp, value));
    pts[i] = value;
  }
  return { pts, step, amp };
}

function layerAt(layer: Layer, n: number): number {
  const i = Math.floor(n / layer.step);
  const t = (n - i * layer.step) / layer.step;
  const s = t * t * (3 - 2 * t);
  return layer.pts[i] * (1 - s) + layer.pts[i + 1] * s;
}

// Interpolation par sinus cardinal fenêtré (Kaiser) : une interpolation cubique
// laissait un résidu à -20 dB sur les aigus, audible comme un grésillement.
const HALF = 16;
const PHASES = 512;

function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 30; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
}

// Table de (PHASES + 1) lignes de 2·HALF coefficients ; `cutoff` < 1 filtre
// avant un sous-échantillonnage pour éviter le repliement.
function makeKernel(cutoff: number): Float32Array {
  const taps = 2 * HALF;
  const beta = 9;
  const norm = bessel0(beta);
  const table = new Float32Array((PHASES + 1) * taps);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const x = j - HALF + 1 - frac;
      const r = x / HALF;
      const win = Math.abs(r) >= 1 ? 0 : bessel0(beta * Math.sqrt(1 - r * r)) / norm;
      const arg = Math.PI * cutoff * x;
      const h = (x === 0 ? 1 : Math.sin(arg) / arg) * win;
      table[p * taps + j] = h;
      sum += h;
    }
    for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;
  }
  return table;
}

function interp(ch: Float32Array, x: number, kernel: Float32Array): number {
  const taps = 2 * HALF;
  const i = Math.floor(x);
  const pf = (x - i) * PHASES;
  const p = Math.floor(pf);
  const a = pf - p;
  const k0 = p * taps;
  const k1 = k0 + taps;
  const first = i - HALF + 1;
  let acc = 0;
  if (first >= 0 && first + taps <= ch.length) {
    for (let j = 0; j < taps; j++) {
      acc += (kernel[k0 + j] + (kernel[k1 + j] - kernel[k0 + j]) * a) * ch[first + j];
    }
  } else {
    for (let j = 0; j < taps; j++) {
      const s = first + j;
      if (s < 0 || s >= ch.length) continue;
      acc += (kernel[k0 + j] + (kernel[k1 + j] - kernel[k0 + j]) * a) * ch[s];
    }
  }
  return acc;
}

function warp(
  channels: Float32Array<ArrayBuffer>[],
  sr: number,
  timingMs: number,
  shortJitterMs: number,
  pitchCents: number,
): Float32Array<ArrayBuffer>[] {
  const len = channels[0].length;
  const phrase = makeLayer(len, sr, timingMs, 1300);
  const jitter = makeLayer(len, sr, shortJitterMs, 70);
  // La vitesse de lecture oscille de ± pitchCents autour de 1 : la position lue
  // est l'intégrale de cette vitesse, donc un décalage borné de lfoDepth échantillons.
  const lfoRate = (2 * Math.PI * 0.09) / sr;
  const lfoDepth = (2 ** (pitchCents / 1200) - 1) / lfoRate;
  const kernel = makeKernel(1);
  const out: Float32Array<ArrayBuffer>[] = channels.map(() => new Float32Array(len));

  for (let n = 0; n < len; n++) {
    const drift = layerAt(phrase, n) + layerAt(jitter, n);
    const lfo = lfoDepth * (1 - Math.cos(n * lfoRate));
    const src = Math.max(0, Math.min(len - 1, n + lfo + drift));
    for (let c = 0; c < channels.length; c++) {
      out[c][n] = interp(channels[c], src, kernel);
    }
  }
  return out;
}

function noiseBuffer(ctx: BaseAudioContext, sr: number): AudioBuffer {
  const buf = ctx.createBuffer(2, Math.floor(sr * 3), sr);
  for (let c = 0; c < 2; c++) {
    const data = buf.getChannelData(c);
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + white * 0.099046;
      b1 = 0.963 * b1 + white * 0.2965164;
      b2 = 0.57 * b2 + white * 1.0526913;
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.18;
    }
  }
  return buf;
}

// Saturation douce de l'exciter, suréchantillonnée ×4 pour ne pas replier
// les harmoniques créées dans l'audible.
function exciterShaper(ctx: BaseAudioContext): WaveShaperNode {
  const soft = ctx.createWaveShaper();
  const n = 4096;
  const c = new Float32Array(n);
  const k = 3;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  soft.curve = c;
  soft.oversample = "4x";
  return soft;
}

function dbToGain(db: number) {
  return Math.pow(10, db / 20);
}

export async function process(
  buffer: AudioBuffer,
  s: Settings,
  onProgress: (ratio: number, step: string) => void,
): Promise<AudioBuffer> {
  const sr = s.sampleRate;
  const src = buffer.numberOfChannels === 1
    ? [buffer.getChannelData(0), buffer.getChannelData(0)]
    : [buffer.getChannelData(0), buffer.getChannelData(1)];
  const inRate = buffer.sampleRate;
  const outLen = Math.max(1, Math.round((buffer.length / inRate) * sr));

  onProgress(0.05, "Rééchantillonnage");
  let channels: Float32Array<ArrayBuffer>[];
  if (inRate !== sr) {
    const ratio = inRate / sr;
    const kernel = makeKernel(Math.min(1, sr / inRate) * 0.96);
    channels = src.map((ch) => {
      const o = new Float32Array(outLen);
      for (let n = 0; n < outLen; n++) o[n] = interp(ch, n * ratio, kernel);
      return o;
    });
  } else {
    channels = src.map((ch) => new Float32Array(ch));
  }

  const moving = s.timingMs > 0 || s.pitchCents > 0 || s.shortJitterMs > 0;
  if (moving) {
    onProgress(0.2, "Micro-timing et dérive de hauteur");
    channels = warp(channels, sr, s.timingMs, s.shortJitterMs, s.pitchCents);
  }

  onProgress(0.4, "Spectre, harmoniques et dynamique");
  const ctx = new OfflineAudioContext(2, channels[0].length, sr);
  const buf = ctx.createBuffer(2, channels[0].length, sr);
  buf.copyToChannel(channels[0], 0);
  buf.copyToChannel(channels[1], 1);

  const source = ctx.createBufferSource();
  source.buffer = buf;

  const bus = ctx.createGain();
  source.connect(bus);

  const preEq = ctx.createGain();
  bus.connect(preEq);

  if (s.exciterDb > -60) {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5200;
    const shaper = exciterShaper(ctx);
    const tame = ctx.createBiquadFilter();
    tame.type = "highshelf";
    tame.frequency.value = Math.min(12500, sr / 2 - 500);
    tame.gain.value = -6;
    const mix = ctx.createGain();
    mix.gain.value = dbToGain(s.exciterDb);
    bus.connect(hp);
    hp.connect(shaper);
    shaper.connect(tame);
    tame.connect(mix);
    mix.connect(preEq);
  }

  let stage: AudioNode = preEq;
  if (s.eqDb > 0) {
    for (const f of EQ_BANDS) {
      const filter = ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = Math.min(f, sr / 2 - 200);
      filter.Q.value = 5.5;
      filter.gain.value = -s.eqDb;
      stage.connect(filter);
      stage = filter;
    }
  }

  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const widthDelay = Math.max(0, s.widthMs) / 1000;
  stage.connect(split);
  split.connect(merge, 0, 0);
  if (widthDelay > 0) {
    const delayR = ctx.createDelay(1);
    delayR.delayTime.value = widthDelay;
    split.connect(delayR, 1);
    delayR.connect(merge, 0, 1);
  } else {
    split.connect(merge, 1, 1);
  }

  let tail: AudioNode = merge;

  if (s.dynDb > 0) {
    const dyn = ctx.createGain();
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.frequency.value = 0.07;
    depth.gain.value = Math.pow(10, s.dynDb / 20) - 1;
    lfo.connect(depth);
    depth.connect(dyn.gain);
    tail.connect(dyn);
    tail = dyn;
    lfo.start();
  }

  if (s.roomDb > -100) {
    const tone = ctx.createBufferSource();
    tone.buffer = noiseBuffer(ctx, sr);
    tone.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 160;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 6200;
    const g = ctx.createGain();
    g.gain.value = dbToGain(s.roomDb);
    const wobble = ctx.createOscillator();
    const wobDepth = ctx.createGain();
    wobble.frequency.value = 0.13;
    wobDepth.gain.value = dbToGain(s.roomDb) * 0.4;
    wobble.connect(wobDepth);
    wobDepth.connect(g.gain);
    tone.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(tail);
    tone.start();
    wobble.start();
  }

  // Le rendu hors ligne est en virgule flottante : rien ne sature ici, la
  // normalisation finale ramène la crête au niveau voulu sans écrêter.
  tail.connect(ctx.destination);
  source.start();

  onProgress(0.6, "Rendu");
  const rendered = await ctx.startRendering();

  onProgress(0.85, "Normalisation");
  let inPeak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > inPeak) inPeak = a;
    }
  }
  let peak = 0;
  for (let c = 0; c < rendered.numberOfChannels; c++) {
    const d = rendered.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  const target = Math.min(inPeak || dbToGain(-1), dbToGain(-1));
  const gain = peak > 0 ? target / peak : 1;
  if (Math.abs(gain - 1) > 0.001) {
    for (let c = 0; c < rendered.numberOfChannels; c++) {
      const d = rendered.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= gain;
    }
  }
  onProgress(1, "Terminé");
  return rendered;
}
