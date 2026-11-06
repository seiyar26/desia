import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PRESETS, process, type Settings } from "./dsp";
import { encodeWav24, peakOf } from "./wav";
import { analyzeBuffer, keyLabel, type Analysis } from "./analysis";
import Advanced from "./Advanced";

type Loaded = { buffer: AudioBuffer; file: File; name: string; url: string };

type Control = {
  key: keyof typeof PRESETS.standard;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  note: string;
  evidence: "mesure" | "hypothese";
};

const fmt = (v: number, digits: number) =>
  v.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const CONTROLS: Control[] = [
  {
    key: "timingMs",
    label: "Flottement de timing",
    unit: "ms",
    min: 0,
    max: 30,
    step: 1,
    format: (v) => `${v} ms`,
    note: "Décale les attaques sur toute la longueur, ce qu'un rendu machine ne fait jamais.",
    evidence: "hypothese",
  },
  {
    key: "shortJitterMs",
    label: "Jitter court",
    unit: "ms",
    min: 0,
    max: 6,
    step: 0.5,
    format: (v) => `${fmt(v, 1)} ms`,
    note: "Deuxième couche, plus fine, sur les transitoires.",
    evidence: "hypothese",
  },
  {
    key: "pitchCents",
    label: "Dérive de hauteur",
    unit: "cents",
    min: 0,
    max: 20,
    step: 1,
    format: (v) => `${v} cents`,
    note: "Un centième de demi-ton près. Une transposition aller-retour, testée seule, n'a rien changé.",
    evidence: "hypothese",
  },
  {
    key: "dynDb",
    label: "Variation de niveau",
    unit: "dB",
    min: 0,
    max: 2.5,
    step: 0.1,
    format: (v) => `± ${fmt(v, 1)} dB`,
    note: "Casse la constance de volume que produit un rendu machine.",
    evidence: "hypothese",
  },
  {
    key: "eqDb",
    label: "Lissage spectral",
    unit: "dB",
    min: 0,
    max: 4,
    step: 0.2,
    format: (v) => `− ${fmt(v, 1)} dB`,
    note: "Creuse cinq bandes fines dans les aigus, là où se logent les pics de génération.",
    evidence: "hypothese",
  },
  {
    key: "exciterDb",
    label: "Harmoniques",
    unit: "dB",
    min: -50,
    max: -6,
    step: 1,
    format: (v) => (v <= -60 ? "coupé" : `${v} dB`),
    note: "Ajoute des harmoniques hautes par saturation douce.",
    evidence: "mesure",
  },
  {
    key: "roomDb",
    label: "Bruit de pièce",
    unit: "dBFS",
    min: -80,
    max: -45,
    step: 1,
    format: (v) => (v <= -80 ? "coupé" : `${v} dBFS`),
    note: "Souffle filtré qui varie lentement, pour remplacer un plancher trop propre.",
    evidence: "hypothese",
  },
  {
    key: "widthMs",
    label: "Écartement stéréo",
    unit: "ms",
    min: 0,
    max: 1.5,
    step: 0.05,
    format: (v) => `${fmt(v, 2)} ms`,
    note: "Retard du canal droit, casse la symétrie parfaite.",
    evidence: "hypothese",
  },
];

type AnalysisState = { status: "running" } | { status: "done"; data: Analysis } | { status: "error" } | null;

type AnalysisRow = { label: string; value: (a: Analysis) => string; num?: (a: Analysis) => number; digits?: number };

const ANALYSIS_ROWS: AnalysisRow[] = [
  { label: "Tempo", value: (a) => `${fmt(a.bpm, 1)} BPM`, num: (a) => a.bpm, digits: 1 },
  { label: "Tonalité", value: keyLabel },
  { label: "Loudness intégrée", value: (a) => `${fmt(a.lufs, 1)} LUFS`, num: (a) => a.lufs, digits: 1 },
  { label: "Plage de loudness", value: (a) => `${fmt(a.lra, 1)} LU`, num: (a) => a.lra, digits: 1 },
  { label: "Complexité dynamique", value: (a) => `${fmt(a.dynamic, 2)} dB`, num: (a) => a.dynamic, digits: 2 },
];

function analysisCell(state: AnalysisState, row: AnalysisRow) {
  if (!state) return "—";
  if (state.status === "running") return "Analyse…";
  if (state.status === "error") return "Échec";
  return row.value(state.data);
}

function analysisDelta(orig: AnalysisState, proc: AnalysisState, row: AnalysisRow) {
  if (!row.num || orig?.status !== "done" || proc?.status !== "done") return null;
  const digits = row.digits ?? 1;
  // Écart calculé sur les valeurs affichées, pour qu'il corresponde à ce qu'on lit.
  const shown = (v: number) => Number(v.toFixed(digits));
  const d = Number((shown(row.num(proc.data)) - shown(row.num(orig.data))).toFixed(digits));
  if (d === 0) return "identique";
  return `${d > 0 ? "+" : "−"}${fmt(Math.abs(d), digits)}`;
}

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

function drawWaveform(canvas: HTMLCanvasElement, buffer: AudioBuffer) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  ctx.clearRect(0, 0, w, h);

  const data = buffer.getChannelData(0);
  const span = Math.floor(data.length / w);
  ctx.fillStyle = getComputedStyle(canvas).getPropertyValue("--wave").trim() || "#6ee7a8";
  const mid = h / 2;

  for (let x = 0; x < w; x++) {
    let min = 1;
    let max = -1;
    const start = x * span;
    for (let i = 0; i < span; i++) {
      const v = data[start + i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const top = mid - max * mid * 0.92;
    const bottom = mid - min * mid * 0.92;
    ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

const PRESET_LABELS: Record<string, string> = {
  discret: "Discret",
  standard: "Standard",
  appuye: "Appuyé",
};

const trackNumber = (i: number) => String(i + 1).padStart(2, "0");

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

export default function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [result, setResult] = useState<{
    blob: Blob;
    buffer: AudioBuffer;
    url: string;
    settingsKey: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ ratio: number; step: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<string | null>("standard");
  const [values, setValues] = useState<Settings>({ ...PRESETS.standard });
  const [enabled, setEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(CONTROLS.map((c) => [c.key, true])),
  );
  const [dragging, setDragging] = useState(false);
  const [listen, setListen] = useState<"orig" | "proc">("proc");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [anaOrig, setAnaOrig] = useState<AnalysisState>(null);
  const [anaProc, setAnaProc] = useState<AnalysisState>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const canvasIn = useRef<HTMLCanvasElement>(null);
  const canvasOut = useRef<HTMLCanvasElement>(null);
  const resultUrl = useRef<string | null>(null);
  const outputHeading = useRef<HTMLHeadingElement>(null);
  const audioOrig = useRef<HTMLAudioElement>(null);
  const audioProc = useRef<HTMLAudioElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    return () => {
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
    };
  }, []);

  useEffect(() => {
    if (!result || !loaded || !canvasOut.current) return;
    drawWaveform(canvasOut.current, listen === "proc" ? result.buffer : loaded.buffer);
  }, [result, loaded, listen]);

  useEffect(() => {
    setAnaOrig(null);
    if (!loaded) return;
    let live = true;
    setAnaOrig({ status: "running" });
    analyzeBuffer(loaded.buffer).then(
      (data) => live && setAnaOrig({ status: "done", data }),
      () => live && setAnaOrig({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [loaded]);

  useEffect(() => {
    setAnaProc(null);
    if (!result) return;
    let live = true;
    setAnaProc({ status: "running" });
    analyzeBuffer(result.buffer).then(
      (data) => live && setAnaProc({ status: "done", data }),
      () => live && setAnaProc({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, [result]);

  useEffect(() => {
    if (loaded && canvasIn.current) drawWaveform(canvasIn.current, loaded.buffer);
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    const url = loaded.url;
    return () => URL.revokeObjectURL(url);
  }, [loaded]);

  useEffect(() => {
    setPlaying(false);
    setTime(0);
    setListen("proc");
    if (!result) return;
    requestAnimationFrame(() => {
      outputHeading.current?.scrollIntoView({
        behavior: prefersReducedMotion() ? "auto" : "smooth",
        block: "start",
      });
      outputHeading.current?.focus({ preventScroll: true });
    });
  }, [result]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const active = listen === "proc" ? audioProc.current : audioOrig.current;
      if (active) setTime(active.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, listen]);

  const load = useCallback(async (file: File) => {
    setError(null);
    setResult(null);
    if (!file.type.startsWith("audio/") && !/\.(wav|mp3|flac|ogg|m4a|aac)$/i.test(file.name)) {
      setError("Ce fichier n'est pas de l'audio.");
      return;
    }
    if (file.size > 120 * 1024 * 1024) {
      setError("Fichier trop lourd : 120 Mo maximum.");
      return;
    }
    setDecoding(true);
    const ctx = new AudioContext();
    try {
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      if (buffer.duration > 12 * 60) {
        setError("Titre trop long : 12 minutes maximum.");
        return;
      }
      setLoaded({ buffer, file, name: file.name, url: URL.createObjectURL(file) });
    } catch {
      setError("Décodage impossible. Essaie un WAV, un MP3 ou un FLAC.");
    } finally {
      setDecoding(false);
      void ctx.close();
    }
  }, []);

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const file = e.dataTransfer?.files[0];
      if (file) void load(file);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [load]);

  const buildSettings = (): Settings => ({
    timingMs: enabled.timingMs ? values.timingMs : 0,
    shortJitterMs: enabled.shortJitterMs ? values.shortJitterMs : 0,
    pitchCents: enabled.pitchCents ? values.pitchCents : 0,
    dynDb: enabled.dynDb ? values.dynDb : 0,
    eqDb: enabled.eqDb ? values.eqDb : 0,
    exciterDb: enabled.exciterDb ? values.exciterDb : -60,
    roomDb: enabled.roomDb ? values.roomDb : -100,
    widthMs: enabled.widthMs ? values.widthMs : 0,
    sampleRate: values.sampleRate,
  });

  const currentKey = JSON.stringify(buildSettings());
  const stale = result !== null && result.settingsKey !== currentKey;

  const run = async () => {
    if (!loaded || busy) return;
    audioOrig.current?.pause();
    audioProc.current?.pause();
    setBusy(true);
    setError(null);
    setProgress({ ratio: 0, step: "Préparation" });
    const settings = buildSettings();
    try {
      const out = await process(loaded.buffer, settings, (ratio, step) => setProgress({ ratio, step }));
      const blob = encodeWav24(out);
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
      const url = URL.createObjectURL(blob);
      resultUrl.current = url;
      setResult({ blob, buffer: out, url, settingsKey: JSON.stringify(settings) });
    } catch {
      setError("Le traitement a échoué. Réessaie avec un autre fichier.");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const download = () => {
    if (!result || !loaded) return;
    const base = loaded.name.replace(/\.[^.]+$/, "");
    const a = document.createElement("a");
    a.href = result.url;
    a.download = `${base} - retravaille ${Math.round(result.buffer.sampleRate / 1000)}k 24bit.wav`;
    a.click();
  };

  const applyPreset = (name: string) => {
    setPreset(name);
    setValues((prev) => ({ ...PRESETS[name], sampleRate: prev.sampleRate }));
    setEnabled(Object.fromEntries(CONTROLS.map((c) => [c.key, true])));
  };

  const sliderFill = (control: Control) =>
    `${((values[control.key] - control.min) / (control.max - control.min)) * 100}%`;

  const activeAudio = () => (listen === "proc" ? audioProc.current : audioOrig.current);
  const duration = result?.buffer.duration ?? 0;

  const togglePlay = () => {
    const active = activeAudio();
    if (!active) return;
    if (active.paused) {
      void active.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      active.pause();
      setPlaying(false);
    }
  };

  const switchTo = (next: "orig" | "proc") => {
    if (next === listen) return;
    const from = activeAudio();
    const to = next === "proc" ? audioProc.current : audioOrig.current;
    if (!from || !to) return;
    to.currentTime = Math.min(from.currentTime, to.duration || from.currentTime);
    if (playing) {
      from.pause();
      void to.play().catch(() => setPlaying(false));
    }
    setListen(next);
  };

  const seek = (seconds: number) => {
    const t = Math.max(0, Math.min(duration, seconds));
    for (const el of [audioOrig.current, audioProc.current]) {
      if (el) el.currentTime = Math.min(t, el.duration || t);
    }
    setTime(t);
  };

  return (
    <div className="page">
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay__panel">
            <WaveIcon />
            <p>Lâche le fichier pour le charger</p>
          </div>
        </div>
      )}

      <header className="topbar">
        <p className="logo">
          Dés-<span>IA</span>
        </p>
        <p className="stamp">
          <LockIcon />
          Traitement dans ton navigateur
        </p>
      </header>

      <section className="hero">
        <div className="hero__text">
          <h1>
            Retouche audio des titres générés <em>par IA</em>
          </h1>
          <p className="hero__lead">
            Huit traitements, du timing au souffle de pièce, appliqués dans ton navigateur. Tu compares
            l'original et le résultat, puis tu télécharges un WAV 24 bits.
          </p>
          <button type="button" className="btn btn--primary btn--lg" onClick={() => inputRef.current?.click()}>
            <UploadIcon />
            Choisir un fichier audio
          </button>
        </div>
        <div className="hero__frame">
          <img className="hero__img" src="/studio.webp" alt="" width={1200} height={800} />
        </div>
      </section>

      <main className="stack">
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void load(file);
            e.target.value = "";
          }}
        />

        <section
          className={`card file ${loaded ? "" : "file--empty"} ${dragging ? "file--over" : ""}`}
          aria-label="Fichier audio"
          aria-busy={decoding}
        >
          {loaded && !decoding ? (
            <>
              <img className="file__cover" src="/pochette.webp" alt="" width={240} height={240} />
              <div className="file__body">
                <div className="file__head">
                  <div className="file__meta">
                    <h2>{loaded.name}</h2>
                    <p>
                      {formatTime(loaded.buffer.duration)} · {loaded.buffer.sampleRate} Hz ·{" "}
                      {loaded.buffer.numberOfChannels === 2 ? "stéréo" : "mono"}
                    </p>
                  </div>
                  <button type="button" className="btn btn--outline" onClick={() => inputRef.current?.click()}>
                    Changer de fichier
                  </button>
                </div>
                <canvas ref={canvasIn} className="wave" aria-label="Forme d'onde du fichier d'origine" />
              </div>
            </>
          ) : (
            <button
              type="button"
              className="drop"
              onClick={() => inputRef.current?.click()}
              disabled={decoding}
            >
              {decoding ? <span className="spinner" aria-hidden="true" /> : <WaveIcon />}
              <span className="drop__title">{decoding ? "Lecture du fichier…" : "Dépose ton fichier audio"}</span>
              <span className="drop__hint">
                {decoding ? "Décodage dans le navigateur" : "Glisse-le n'importe où sur la page, ou clique ici"}
              </span>
              <span className="drop__hint">WAV, MP3, FLAC ou OGG · 120 Mo et 12 minutes maximum</span>
            </button>
          )}
        </section>

        {loaded && (
          <section
            className="card analysis"
            aria-labelledby="analyse"
            aria-busy={anaOrig?.status === "running" || anaProc?.status === "running"}
          >
            <div className="card__head">
              <span className="icon-box">
                <ChartIcon />
              </span>
              <div>
                <h2 id="analyse">Analyse du titre</h2>
                <p className="sub">Mesures calculées dans ton navigateur, avant et après traitement.</p>
              </div>
            </div>
            <table className="analysis__table">
              <thead>
                <tr>
                  <th scope="col">Mesure</th>
                  <th scope="col">Original</th>
                  <th scope="col">Retravaillé</th>
                </tr>
              </thead>
              <tbody>
                {ANALYSIS_ROWS.map((row) => {
                  const delta = analysisDelta(anaOrig, anaProc, row);
                  return (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      <td className={anaOrig?.status === "done" ? "" : "is-wait"}>
                        <span className="analysis__value">{analysisCell(anaOrig, row)}</span>
                      </td>
                      <td className={anaProc?.status === "done" ? "is-proc" : "is-wait"}>
                        <span className="analysis__value">{result ? analysisCell(anaProc, row) : "après traitement"}</span>
                        {delta && <span className="analysis__delta">{delta}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="analysis__note">
              Analyse par{" "}
              <a href="https://github.com/MTG/essentia.js" target="_blank" rel="noreferrer">
                Essentia.js
              </a>{" "}
              (Music Technology Group, UPF), licence AGPL-3.0. Ces mesures décrivent le son ; elles ne
              prédisent pas le verdict d'un détecteur.
            </p>
          </section>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {loaded && (
          <section className="card presets" aria-labelledby="presets-title">
            <span className="icon-box">
              <SlidersIcon />
            </span>
            <div className="presets__text">
              <h2 id="presets-title">Préréglages</h2>
              <p className="sub">
                {preset ? "Trois dosages de départ, à ajuster ensuite." : "Réglages personnalisés."}
              </p>
            </div>
            <div className="segmented" role="group" aria-labelledby="presets-title">
              {Object.keys(PRESETS).map((key) => (
                <button key={key} type="button" aria-pressed={preset === key} onClick={() => applyPreset(key)}>
                  {PRESET_LABELS[key] ?? key}
                </button>
              ))}
            </div>
          </section>
        )}

        {loaded && (
          <section className="card settings" aria-labelledby="reglages">
            <div className="card__head">
              <span className="icon-box">
                <WaveIcon />
              </span>
              <h2 id="reglages">Réglages</h2>
              <span className="card__range">{CONTROLS.length} traitements</span>
            </div>

            <ol className="tracks">
              {CONTROLS.map((control, i) => {
                const on = enabled[control.key];
                return (
                  <li className={`track ${on ? "" : "track--off"}`} key={control.key}>
                    <span className="track__code" aria-hidden="true">
                      {trackNumber(i)}
                    </span>
                    <label className="track__toggle">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          setPreset(null);
                          setEnabled((prev) => ({ ...prev, [control.key]: e.target.checked }));
                        }}
                        aria-label={`Activer ${control.label}`}
                      />
                    </label>
                    <div className="track__text">
                      <label className="track__label" htmlFor={`range-${control.key}`}>
                        {control.label}
                      </label>
                      <p id={`${control.key}-note`} className="track__note">
                        {control.note}{" "}
                        <span className={`tag tag--${control.evidence}`}>
                          {control.evidence === "mesure" ? "Testé seul : sans effet" : "Non testé"}
                        </span>
                      </p>
                    </div>
                    <input
                      id={`range-${control.key}`}
                      className="track__range"
                      type="range"
                      min={control.min}
                      max={control.max}
                      step={control.step}
                      value={values[control.key]}
                      disabled={!on}
                      style={{ "--fill": sliderFill(control) } as CSSProperties}
                      onChange={(e) => {
                        setPreset(null);
                        setValues((prev) => ({ ...prev, [control.key]: Number(e.target.value) }));
                      }}
                      aria-describedby={`${control.key}-note`}
                      aria-valuetext={control.format(values[control.key])}
                    />
                    <output className="track__value" htmlFor={`range-${control.key}`}>
                      {on
                        ? control.format(values[control.key])
                        : control.key === "exciterDb" || control.key === "roomDb"
                          ? "coupé"
                          : control.format(0)}
                    </output>
                  </li>
                );
              })}
            </ol>

            <div className="settings__foot">
              <label className="settings__sr" htmlFor="sr">
                Fréquence de sortie
              </label>
              <select
                id="sr"
                value={values.sampleRate}
                onChange={(e) => setValues((prev) => ({ ...prev, sampleRate: Number(e.target.value) }))}
              >
                <option value={48000}>48 000 Hz (standard diffusion)</option>
                <option value={44100}>44 100 Hz (CD)</option>
              </select>
              <button type="button" className="btn btn--primary" onClick={() => void run()} disabled={busy}>
                {busy ? "Traitement en cours…" : result ? "Relancer le traitement" : "Retravailler le titre"}
              </button>
            </div>
            {progress && (
              <div className="progress" role="status">
                <div className="progress__bar" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
                <span>
                  {progress.step} · {Math.round(progress.ratio * 100)} %
                </span>
              </div>
            )}
          </section>
        )}

        {result && loaded && (
          <section className="card output" aria-labelledby="resultat">
            <div className="card__head">
              <span className="icon-box">
                <DiscIcon />
              </span>
              <div>
                <h2 id="resultat" ref={outputHeading} tabIndex={-1}>
                  Fichier retravaillé
                </h2>
                <p className="sub">Compare les deux versions au même endroit, puis télécharge.</p>
              </div>
            </div>

            {stale && (
              <p className="stale" role="status">
                Les réglages ont changé depuis ce rendu. Relance le traitement pour les entendre.
              </p>
            )}

            <div
              className="scrub"
              onPointerDown={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                seek(((e.clientX - rect.left) / rect.width) * duration);
              }}
            >
              <canvas
                ref={canvasOut}
                className={`wave wave--tall ${listen === "orig" ? "wave--orig" : ""}`}
                aria-hidden="true"
              />
              <span
                className="scrub__head"
                style={{ left: `${duration ? (time / duration) * 100 : 0}%` }}
                aria-hidden="true"
              />
            </div>

            <div className="player">
              <button
                type="button"
                className="player__play"
                onClick={togglePlay}
                aria-label={playing ? "Pause" : "Lecture"}
              >
                {playing ? <PauseIcon /> : <PlayIcon />}
              </button>
              <input
                className="player__seek track__range"
                type="range"
                min={0}
                max={duration}
                step={0.1}
                value={time}
                style={{ "--fill": `${duration ? (time / duration) * 100 : 0}%` } as CSSProperties}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Position de lecture"
                aria-valuetext={`${formatTime(time)} sur ${formatTime(duration)}`}
              />
              <span className="player__time">
                {formatTime(time)} / {formatTime(duration)}
              </span>
              <div className="segmented segmented--ab" role="group" aria-label="Version écoutée">
                <button type="button" aria-pressed={listen === "orig"} onClick={() => switchTo("orig")}>
                  Original
                </button>
                <button type="button" aria-pressed={listen === "proc"} onClick={() => switchTo("proc")}>
                  Retravaillé
                </button>
              </div>
              <audio
                ref={audioOrig}
                src={loaded.url}
                preload="auto"
                onEnded={() => setPlaying(false)}
              />
              <audio
                ref={audioProc}
                src={result.url}
                preload="auto"
                onEnded={() => setPlaying(false)}
              />
            </div>

            <dl className="facts">
              <div>
                <dt>Durée</dt>
                <dd>{formatTime(result.buffer.duration)}</dd>
              </div>
              <div>
                <dt>Format</dt>
                <dd>WAV 24 bits · {result.buffer.sampleRate} Hz</dd>
              </div>
              <div>
                <dt>Crête</dt>
                <dd>{fmt(20 * Math.log10(peakOf(result.buffer) || 1), 1)} dBFS</dd>
              </div>
              <div>
                <dt>Poids</dt>
                <dd>{fmt(result.blob.size / 1048576, 1)} Mo</dd>
              </div>
            </dl>

            <div className="output__foot">
              <button type="button" className="btn btn--primary" onClick={download}>
                <DownloadIcon />
                Télécharger le WAV
              </button>
              <p>
                Fichier sans compression, prêt pour le mastering. Passe-le dans un détecteur avant de
                distribuer : <strong>aucun réglage ne garantit un passage.</strong>
              </p>
            </div>
          </section>
        )}

        {loaded && <Advanced file={loaded.file} duration={loaded.buffer.duration} />}

        <section className="card note" aria-labelledby="note-title">
          <div className="sleeve" aria-hidden="true">
            <div className="sleeve__disc" />
            <div className="sleeve__cover">
              <p className="sleeve__logo">Dés-IA</p>
              <ol>
                {CONTROLS.map((c, i) => (
                  <li key={c.key}>
                    {trackNumber(i)}. {c.label}
                  </li>
                ))}
              </ol>
              <p className="sleeve__sticker">Traitement local</p>
            </div>
          </div>
          <div className="note__text">
            <h2 id="note-title">Limites de l'outil</h2>
            <p className="sub">Ce qui a été mesuré, et ce qui ne l'a pas été.</p>
            <p>
              Sur un morceau de test noté 99,3 % IA par ACRCloud, trois traitements passés seuls —
              transposition aller-retour, rééchantillonnage à 22 kHz, exciter — n'ont pas fait bouger le
              score d'un point. L'outil les combine et ajoute deux traitements non testés : le flottement de
              timing et le bruit de pièce.
            </p>
            <p>
              Plus tu pousses, plus le son s'éloigne du rendu machine, et plus il se dégrade. Commence par
              « Discret », écoute, et monte seulement si le détecteur résiste. Le levier le plus solide
              reste de rejouer la voix ou des instruments par-dessus.
            </p>
          </div>
        </section>
      </main>

      <footer className="footer">
        <p>
          Le traitement se fait dans ton navigateur. Seule l'analyse avancée envoie le fichier, à ta demande.{" "}
          <a href="https://github.com/seiyar26/desia" target="_blank" rel="noreferrer">
            Code source (AGPL-3.0)
          </a>
        </p>
        <p className="footer__brand">
          Dés-<span>IA</span>
        </p>
      </footer>
    </div>
  );
}

function Icon({ size = 22, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function SlidersIcon() {
  return (
    <Icon>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </Icon>
  );
}

function WaveIcon() {
  return (
    <Icon>
      <path d="M3 10v4M7 7v10M11 4v16M15 8v8M19 6v12" />
    </Icon>
  );
}

function DiscIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

function ChartIcon() {
  return (
    <Icon>
      <path d="M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3M20 16V6" />
    </Icon>
  );
}

function LockIcon() {
  return (
    <Icon size={16}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

function UploadIcon() {
  return (
    <Icon size={20}>
      <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
    </Icon>
  );
}

function DownloadIcon() {
  return (
    <Icon size={20}>
      <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />
    </Icon>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
