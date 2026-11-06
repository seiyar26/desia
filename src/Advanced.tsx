import { useEffect, useState, type ReactNode } from "react";

export const ANALYSE_API = "https://desia.72-60-44-179.sslip.io";
const MAX_SECONDS = 10 * 60;
const MAX_BYTES = 100 * 1024 * 1024;

type Failed = { error: string };
type Segment = { start: number; end: number; label: string };

type Results = {
  duration?: number;
  librosa?:
    | {
        tempo: number;
        centroid_hz: number;
        rolloff_hz: number;
        bandwidth_hz: number;
        flatness: number;
        cutoff_hz: number;
        hf_energy_db: number;
      }
    | Failed;
  essentia?:
    | {
        bpm: number;
        key: string;
        scale: string;
        key_strength: number;
        danceability: number;
        genres: { label: string; prob: number }[];
        moods: Record<"happy" | "sad" | "aggressive" | "relaxed" | "party", number>;
      }
    | Failed;
  allin1?: { bpm: number; beats: number; downbeats: number; segments: Segment[] } | Failed;
  basic_pitch?: { notes: number; lowest: string; highest: string; midi: string } | Failed;
  demucs?: { stems: Record<"vocals" | "drums" | "bass" | "other", string> } | Failed;
  flamingo?: { text: string } | Failed;
};

type Job = {
  id: string;
  status: "queued" | "running" | "done" | "error";
  position: number | null;
  step: string | null;
  steps_done: string[];
  results: Results;
  error: string | null;
};

export const TOOLS = [
  { name: "Essentia", what: "Tempo, tonalité, ambiance, genre, dansabilité", url: "https://github.com/MTG/essentia" },
  { name: "librosa", what: "Tempo, spectre, timbre", url: "https://github.com/librosa/librosa" },
  { name: "Demucs", what: "Sépare voix, basse, batterie et le reste", url: "https://github.com/adefossez/demucs" },
  { name: "All-In-One", what: "Temps, mesures, sections (intro, refrain…)", url: "https://github.com/mir-aidj/all-in-one" },
  { name: "Basic Pitch", what: "Notes jouées, exportées en MIDI", url: "https://github.com/spotify/basic-pitch" },
  { name: "Audio Flamingo", what: "Description du morceau en texte", url: "https://github.com/NVIDIA/audio-flamingo" },
];

const SECTION_FR: Record<string, string> = {
  start: "Début",
  intro: "Intro",
  verse: "Couplet",
  chorus: "Refrain",
  bridge: "Pont",
  inst: "Instrumental",
  solo: "Solo",
  break: "Pause",
  outro: "Outro",
  end: "Fin",
};

const STEMS: { key: "vocals" | "drums" | "bass" | "other"; label: string }[] = [
  { key: "vocals", label: "Voix" },
  { key: "drums", label: "Batterie" },
  { key: "bass", label: "Basse" },
  { key: "other", label: "Autres instruments" },
];

const MOODS: { key: "happy" | "sad" | "aggressive" | "relaxed" | "party"; label: string }[] = [
  { key: "happy", label: "Joyeux" },
  { key: "sad", label: "Triste" },
  { key: "aggressive", label: "Agressif" },
  { key: "relaxed", label: "Détendu" },
  { key: "party", label: "Festif" },
];

const fmt = (v: number, digits: number) =>
  v.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const pct = (v: number) => `${Math.round(v * 100)} %`;

const fileUrl = (id: string, name: string) =>
  `${ANALYSE_API}/api/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`;

function isFailed<T extends object>(v: T | Failed): v is Failed {
  return "error" in v;
}

function Block<T extends object>({
  title,
  tool,
  value,
  children,
}: {
  title: string;
  tool: string;
  value: T | Failed | undefined;
  children: (v: T) => ReactNode;
}) {
  return (
    <section className="adv__block" aria-label={title}>
      <h3>
        {title} <span className="adv__tool">{tool}</span>
      </h3>
      {value === undefined ? (
        <p className="adv__wait">Pas encore calculé.</p>
      ) : isFailed(value) ? (
        <p className="adv__fail">Échec de cette analyse : {value.error}</p>
      ) : (
        children(value)
      )}
    </section>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="meter">
      <span className="meter__label">{label}</span>
      <span className="meter__track" aria-hidden="true">
        <span className="meter__fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
      </span>
      <span className="meter__value">{pct(value)}</span>
    </div>
  );
}

export default function Advanced({ file, duration }: { file: File | null; duration: number }) {
  const [describe, setDescribe] = useState(false);
  const [sending, setSending] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiUp, setApiUp] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`${ANALYSE_API}/api/health`)
      .then((res) => (res.ok ? res.json() : null))
      .then((h: { ok?: boolean } | null) => live && setApiUp(!!h?.ok))
      .catch(() => live && setApiUp(false));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    setJob(null);
    setError(null);
    setSending(false);
  }, [file]);

  const jobId = job?.id;
  const finished = job?.status === "done" || job?.status === "error";

  useEffect(() => {
    if (!jobId || finished) return;
    let live = true;
    let timer = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${ANALYSE_API}/api/jobs/${encodeURIComponent(jobId)}`);
        if (!res.ok) throw new Error(res.status === 404 ? "Analyse expirée sur le serveur." : `Erreur ${res.status}`);
        const next = (await res.json()) as Job;
        if (!live) return;
        setJob(next);
        if (next.status !== "done" && next.status !== "error") timer = window.setTimeout(poll, 2500);
      } catch (err) {
        if (!live) return;
        setError(err instanceof Error ? err.message : "Serveur d'analyse injoignable.");
      }
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [jobId, finished]);

  const tooLong = duration > MAX_SECONDS;
  const tooBig = !!file && file.size > MAX_BYTES;

  async function send() {
    if (!file) return;
    setSending(true);
    setError(null);
    setJob(null);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("describe", describe ? "1" : "0");
      const res = await fetch(`${ANALYSE_API}/api/jobs`, { method: "POST", body });
      if (!res.ok) {
        const message =
          res.status === 413
            ? "Fichier trop lourd pour le serveur (100 Mo au plus)."
            : res.status === 415
              ? "Le serveur ne sait pas lire ce format."
              : res.status === 429
                ? "Le serveur est occupé. Réessaie dans quelques minutes."
                : `Le serveur a refusé l'envoi (erreur ${res.status}).`;
        throw new Error(message);
      }
      const { id } = (await res.json()) as { id: string };
      setJob({ id, status: "queued", position: null, step: null, steps_done: [], results: {}, error: null });
    } catch (err) {
      setError(
        err instanceof TypeError ? "Serveur d'analyse injoignable." : err instanceof Error ? err.message : String(err),
      );
    } finally {
      setSending(false);
    }
  }

  const r = job?.results ?? {};
  const running = !!job && !finished;

  // Sans serveur joignable, pas de bouton d'envoi qui mène nulle part.
  if (!apiUp) return null;

  return (
    <section className="card adv" aria-labelledby="analyse-avancee" aria-busy={running}>
      <div className="card__head">
        <span className="icon-box">
          <ServerIcon />
        </span>
        <div>
          <h2 id="analyse-avancee">Analyse avancée</h2>
          <p className="sub">Six outils de recherche audio, exécutés sur notre serveur.</p>
        </div>
      </div>

      <table className="adv__tools">
        <thead>
          <tr>
            <th scope="col">Outil</th>
            <th scope="col">Ce qu'il analyse</th>
          </tr>
        </thead>
        <tbody>
          {TOOLS.map((t) => (
            <tr key={t.name}>
              <th scope="row">
                <a href={t.url} target="_blank" rel="noreferrer">
                  {t.name}
                </a>
              </th>
              <td>{t.what}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="adv__consent">
        Contrairement au reste de l'outil, cette analyse <strong>envoie ton fichier</strong> à notre serveur. Il y
        est effacé une heure après l'analyse, avec tous les résultats. Compte environ 15 minutes pour un titre de
        3 minutes, 20 avec la description.
      </p>

      <div className="adv__send">
        <label className="adv__check">
          <span className="track__toggle">
            <input type="checkbox" checked={describe} onChange={(e) => setDescribe(e.target.checked)} />
          </span>
          Ajouter une description en anglais (Audio Flamingo, environ 5 min de plus)
        </label>
        <button
          type="button"
          className="btn btn--outline"
          onClick={send}
          disabled={!file || sending || running || tooLong || tooBig}
        >
          <SendIcon />
          {job ? "Relancer l'analyse avancée" : "Envoyer pour l'analyse avancée"}
        </button>
      </div>
      {!file && <p className="adv__wait adv__hint">Dépose d'abord un titre en haut de la page pour l'envoyer.</p>}
      {(tooLong || tooBig) && (
        <p className="adv__fail">Le serveur accepte 10 minutes et 100 Mo au plus. Ce fichier dépasse cette limite.</p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {(sending || running) && (
        <div className="adv__status" role="status">
          <span className="spinner spinner--sm" aria-hidden="true" />
          <span>
            {sending
              ? "Envoi du fichier…"
              : job?.status === "queued"
                ? job.position
                  ? `En attente, position ${job.position} dans la file.`
                  : "En attente du serveur…"
                : `${job?.step ?? "Analyse en cours"}… (${job?.steps_done.length ?? 0} étape${(job?.steps_done.length ?? 0) > 1 ? "s" : ""} terminée${(job?.steps_done.length ?? 0) > 1 ? "s" : ""})`}
          </span>
        </div>
      )}

      {job?.status === "error" && (
        <p className="error" role="alert">
          L'analyse a échoué : {job.error ?? "erreur inconnue"}
        </p>
      )}

      {job && (Object.keys(r).length > 0 || finished) && (
        <div className="adv__results">
          <Block title="Structure" tool="All-In-One" value={r.allin1}>
            {(a) => {
              const total = r.duration ?? a.segments.at(-1)?.end ?? 1;
              const parts = a.segments.filter((s) => s.end - s.start > 0.05);
              return (
                <>
                  <div className="sections" aria-hidden="true">
                    {parts.map((s, i) => (
                      <span
                        key={i}
                        className={`sections__part sections__part--${SECTION_FR[s.label] ? s.label : "other"}`}
                        style={{ flexGrow: s.end - s.start }}
                        title={`${SECTION_FR[s.label] ?? s.label} · ${clock(s.start)}–${clock(s.end)}`}
                      >
                        {(s.end - s.start) / total > 0.07 ? (SECTION_FR[s.label] ?? s.label) : ""}
                      </span>
                    ))}
                  </div>
                  <ol className="sections__list">
                    {parts.map((s, i) => (
                      <li key={i}>
                        <span>{clock(s.start)}</span> {SECTION_FR[s.label] ?? s.label}
                      </li>
                    ))}
                  </ol>
                  <dl className="facts facts--3">
                    <div>
                      <dt>Tempo</dt>
                      <dd>{fmt(a.bpm, 0)} BPM</dd>
                    </div>
                    <div>
                      <dt>Temps</dt>
                      <dd>{a.beats}</dd>
                    </div>
                    <div>
                      <dt>Mesures</dt>
                      <dd>{a.downbeats}</dd>
                    </div>
                  </dl>
                </>
              );
            }}
          </Block>

          <Block title="Pistes séparées" tool="Demucs" value={r.demucs}>
            {(d) => (

                <ul className="stems">
                  {STEMS.map((s) => (
                    <li key={s.key}>
                      <span className="stems__label">{s.label}</span>
                      <audio controls preload="none" src={fileUrl(job.id, d.stems[s.key])} aria-label={s.label} />
                      <a className="stems__dl" href={fileUrl(job.id, d.stems[s.key])} download>
                        <DownloadIcon />
                        <span className="visually-hidden">Télécharger la piste </span>
                        FLAC
                      </a>
                    </li>
                  ))}
                </ul>
            )}
          </Block>

          <Block title="Notes" tool="Basic Pitch" value={r.basic_pitch}>
            {(b) => (
                <div className="adv__row">
                  <p>
                    <strong>{b.notes.toLocaleString("fr-FR")} notes</strong> détectées, de {b.lowest} à {b.highest}.
                  </p>
                  <a className="btn btn--outline" href={fileUrl(job.id, b.midi)} download>
                    <DownloadIcon />
                    Télécharger le MIDI
                  </a>
                </div>
            )}
          </Block>

          <Block title="Spectre" tool="librosa" value={r.librosa}>
            {(l) => (
                <dl className="facts">
                  <div>
                    <dt>Tempo</dt>
                    <dd>{fmt(l.tempo, 1)} BPM</dd>
                  </div>
                  <div>
                    <dt>Centre spectral</dt>
                    <dd>{fmt(l.centroid_hz / 1000, 2)} kHz</dd>
                  </div>
                  <div>
                    <dt>Coupure haute</dt>
                    <dd>{fmt(l.cutoff_hz / 1000, 1)} kHz</dd>
                  </div>
                  <div>
                    <dt>Énergie &gt; 16 kHz</dt>
                    <dd>{fmt(l.hf_energy_db, 1)} dB</dd>
                  </div>
                  <div>
                    <dt>99 % de l'énergie sous</dt>
                    <dd>{fmt(l.rolloff_hz / 1000, 1)} kHz</dd>
                  </div>
                  <div>
                    <dt>Largeur spectrale</dt>
                    <dd>{fmt(l.bandwidth_hz / 1000, 2)} kHz</dd>
                  </div>
                  <div>
                    <dt>Platitude</dt>
                    <dd>{fmt(l.flatness, 3)}</dd>
                  </div>
                </dl>
            )}
          </Block>

          <Block title="Genre et ambiance" tool="Essentia" value={r.essentia}>
            {(e) => (
                <div className="adv__cols">
                  <div>
                    <h4>Genres probables</h4>
                    {e.genres.map((g) => (
                      <Meter key={g.label} label={g.label.replace("---", " · ")} value={g.prob} />
                    ))}
                  </div>
                  <div>
                    <h4>Ambiance</h4>
                    {MOODS.map((m) => (
                      <Meter key={m.key} label={m.label} value={e.moods[m.key]} />
                    ))}
                    <Meter label="Dansabilité" value={e.danceability} />
                  </div>
                </div>
            )}
          </Block>

          {(describe || r.flamingo) && (
            <Block title="Description" tool="Audio Flamingo" value={r.flamingo}>
              {(f) => <blockquote className="adv__quote">{f.text}</blockquote>}
            </Block>
          )}
        </div>
      )}
    </section>
  );
}

function Svg({ children, size = 22 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function ServerIcon() {
  return (
    <Svg>
      <rect x="4" y="4" width="16" height="7" rx="1.5" />
      <rect x="4" y="13" width="16" height="7" rx="1.5" />
      <path d="M8 7.5h.01M8 16.5h.01" />
    </Svg>
  );
}

function SendIcon() {
  return (
    <Svg size={20}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  );
}

function DownloadIcon() {
  return (
    <Svg size={18}>
      <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />
    </Svg>
  );
}
