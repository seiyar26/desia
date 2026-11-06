"""API d'analyse avancée Dés-IA : orchestrateur FastAPI + runners isolés (un venv par outil)."""
import json, os, queue, re, shutil, subprocess, threading, time, uuid
from pathlib import Path

import psutil
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

DATA = Path(os.environ.get("DATA_DIR", "/data")) / "jobs"
DATA.mkdir(parents=True, exist_ok=True)
VENV = Path("/venvs")
RUNNERS = Path(__file__).parent / "runners"
MAX_BYTES = 100 * 1024 * 1024
MAX_SECONDS = 600
MAX_ACTIVE = 4
TTL = 3600
THREADS = "6"
STEP_TIMEOUT = {"flamingo": 1800}
DEFAULT_TIMEOUT = 1200

ORIGINS = ["https://desia-nine.vercel.app", "http://127.0.0.1:4173", "http://localhost:5173"]
LABELS = {
    "prep": "Préparation de l'audio",
    "librosa": "Analyse spectrale (librosa)",
    "demucs": "Séparation des pistes (Demucs)",
    "allin1": "Structure du morceau (all-in-one)",
    "essentia": "Tempo, tonalité et genre (Essentia)",
    "basic_pitch": "Transcription MIDI (Basic Pitch)",
    "flamingo": "Description du morceau (Audio Flamingo 3)",
}
MIME = {".flac": "audio/flac", ".mid": "audio/midi"}
STEMS = ("vocals", "drums", "bass", "other")

app = FastAPI(title="Dés-IA analyse avancée")
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST", "OPTIONS"],
                   allow_headers=["*"], expose_headers=["Content-Disposition"], max_age=86400)

jobs: dict[str, dict] = {}
lock = threading.Lock()
pending: "queue.Queue[str]" = queue.Queue()
order: list[str] = []  # ids en file d'attente


def run_py(venv, script, args, timeout, timings_key=None):
    """Lance un runner dans son venv, renvoie le JSON de la dernière ligne stdout.
    Mesure la RAM maximale (somme RSS de l'arbre de processus)."""
    env = {**os.environ, "OMP_NUM_THREADS": THREADS, "MKL_NUM_THREADS": THREADS, "OPENBLAS_NUM_THREADS": THREADS,
           "TF_NUM_INTRAOP_THREADS": THREADS, "TF_CPP_MIN_LOG_LEVEL": "3", "NUMBA_NUM_THREADS": THREADS}
    cmd = ["nice", "-n", "10", str(VENV / venv / "bin/python"), str(RUNNERS / script), *map(str, args)]
    t0 = time.time()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True)
    peak = 0
    stop = threading.Event()

    def watch():
        nonlocal peak
        try:
            root = psutil.Process(p.pid)
            while not stop.is_set():
                rss = 0
                for q in [root, *root.children(recursive=True)]:
                    try:
                        rss += q.memory_info().rss
                    except psutil.Error:
                        pass
                peak = max(peak, rss)
                time.sleep(0.5)
        except psutil.Error:
            pass

    threading.Thread(target=watch, daemon=True).start()
    try:
        out, err = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        p.communicate()
        raise RuntimeError(f"délai dépassé ({timeout // 60} min)")
    finally:
        stop.set()
        run_py.last = {"seconds": round(time.time() - t0, 1), "peak_rss_mb": round(peak / 1048576)}
    if p.returncode != 0:
        tail = (err or "").strip().splitlines()[-3:]
        raise RuntimeError(f"code {p.returncode}: " + " | ".join(tail)[-400:])
    lines = [l for l in out.strip().splitlines() if l.startswith("{")]
    if not lines:
        raise RuntimeError("sortie vide")
    return json.loads(lines[-1])


run_py.last = {}


def sh(cmd, timeout=300):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def run_job(job):
    jid = job["id"]
    d = DATA / jid
    files = d / "files"
    files.mkdir(exist_ok=True)
    wav = d / "audio.wav"
    demix = d / "demix"
    res = job["results"]

    def step(key, fn, venv, script, args):
        job["step"] = LABELS[key]
        try:
            res[key] = fn(run_py(venv, script, args, STEP_TIMEOUT.get(key, DEFAULT_TIMEOUT)))
        except Exception as e:  # une étape en échec n'arrête pas les suivantes
            res[key] = {"error": str(e)[:500]}
            run_py.last = getattr(run_py, "last", {})
        job["timings"][key] = dict(run_py.last)
        job["steps_done"].append(LABELS[key])

    job["step"] = LABELS["prep"]
    r = sh(["ffmpeg", "-y", "-v", "error", "-i", str(job["src"]), "-vn", "-ac", "2", "-ar", "44100",
            "-c:a", "pcm_s16le", str(wav)])
    if r.returncode != 0:
        job["status"], job["error"] = "error", "Impossible de décoder ce fichier audio."
        return
    job["src"].unlink(missing_ok=True)
    job["steps_done"].append(LABELS["prep"])

    step("librosa", lambda o: o, "main", "librosa_run.py", [wav])

    def demucs_post(_):
        stems = {}
        src = demix / "htdemucs" / "audio"
        for s in STEMS:
            out = files / f"{s}.flac"
            r = sh(["nice", "-n", "10", "ffmpeg", "-y", "-v", "error", "-i", str(src / f"{s}.wav"), "-ac", "2",
                    "-ar", "44100", "-sample_fmt", "s16", str(out)])
            if r.returncode != 0:
                raise RuntimeError(f"conversion FLAC ({s}) impossible")
            stems[s] = out.name
        return {"stems": stems}

    step("demucs", demucs_post, "allin1", "demucs_run.py", [wav, demix])
    if "error" not in res["demucs"]:
        step("allin1", lambda o: o, "allin1", "allin1_run.py", [wav, demix, d / "spec"])
    else:
        job["step"] = LABELS["allin1"]
        res["allin1"] = {"error": "séparation des pistes indisponible"}
        job["steps_done"].append(LABELS["allin1"])
    shutil.rmtree(demix, ignore_errors=True)
    shutil.rmtree(d / "spec", ignore_errors=True)

    step("essentia", lambda o: o, "essentia", "essentia_run.py", [wav])
    midi = files / "notes.mid"
    step("basic_pitch", lambda o: {**o, "midi": midi.name}, "bp", "basic_pitch_run.py", [wav, midi])
    if job["describe"]:
        step("flamingo", lambda o: o, "flamingo", "flamingo_run.py", [wav])
    wav.unlink(missing_ok=True)
    job["status"], job["step"] = "done", None


def worker():
    while True:
        jid = pending.get()
        job = jobs.get(jid)
        if not job:
            continue
        with lock:
            order.remove(jid)
            job["status"] = "running"
        t0 = time.time()
        try:
            run_job(job)
        except Exception as e:
            job["status"], job["error"] = "error", "Erreur interne pendant l'analyse."
            print("job error", jid, type(e).__name__, flush=True)
        job["step"] = None
        job["timings"]["total_seconds"] = round(time.time() - t0, 1)
        job["finished"] = time.time()
        print("job", jid, job["status"], json.dumps(job["timings"]), flush=True)


def janitor():
    while True:
        time.sleep(60)
        now = time.time()
        for jid, j in list(jobs.items()):
            if j.get("finished") and now - j["finished"] > TTL:
                jobs.pop(jid, None)
                shutil.rmtree(DATA / jid, ignore_errors=True)
        for p in DATA.iterdir():  # dossiers orphelins (redémarrage)
            if p.name not in jobs and now - p.stat().st_mtime > TTL:
                shutil.rmtree(p, ignore_errors=True)


@app.on_event("startup")
def startup():
    for p in DATA.iterdir():
        shutil.rmtree(p, ignore_errors=True)
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=janitor, daemon=True).start()


@app.get("/api/health")
def health():
    tools = {}
    for name, venv, mod in [("librosa", "main", "librosa"), ("essentia", "essentia", "essentia-tensorflow"),
                            ("allin1", "allin1", "allin1"), ("demucs", "allin1", "demucs"),
                            ("basic_pitch", "bp", "basic-pitch"), ("transformers", "flamingo", "transformers")]:
        try:
            r = sh([str(VENV / venv / "bin/python"), "-c",
                    f"import importlib.metadata as m;print(m.version('{mod}'))"], 20)
            tools[name] = r.stdout.strip() or "?"
        except Exception:
            tools[name] = "?"
    tools["ffmpeg"] = (sh(["ffmpeg", "-version"]).stdout.split() or ["", "", "?"])[2]
    return {"ok": True, "tools": tools}


@app.post("/api/jobs", status_code=202)
async def create_job(file: UploadFile = File(...), describe: str = Form("0")):
    with lock:
        if len(order) + (1 if any(j["status"] == "running" for j in jobs.values()) else 0) >= MAX_ACTIVE:
            raise HTTPException(429, "File d'attente pleine, réessayez dans quelques minutes.")
    jid = uuid.uuid4().hex[:16]
    d = DATA / jid
    d.mkdir()
    src = d / "upload.bin"
    size = 0
    try:
        with open(src, "wb") as f:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(413, "Fichier trop volumineux (100 Mo maximum).")
                f.write(chunk)
        r = sh(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "format=duration",
                "-of", "default=nw=1:nk=1", str(src)], 30)
        try:
            dur = float(r.stdout.strip())
        except ValueError:
            raise HTTPException(415, "Fichier audio illisible.")
        if dur > MAX_SECONDS:
            raise HTTPException(413, "Morceau trop long (10 minutes maximum).")
    except HTTPException:
        shutil.rmtree(d, ignore_errors=True)
        raise
    job = {"id": jid, "status": "queued", "step": None, "steps_done": [], "results": {"duration": round(dur, 2)},
           "error": None, "describe": describe == "1", "src": src, "timings": {}, "created": time.time()}
    with lock:
        jobs[jid] = job
        order.append(jid)
    pending.put(jid)
    return {"id": jid}


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    j = jobs.get(jid)
    if not j:
        raise HTTPException(404, "Analyse introuvable ou expirée.")
    with lock:
        pos = order.index(jid) if jid in order else None
    return {"id": jid, "status": j["status"], "position": pos, "step": j["step"], "steps_done": j["steps_done"],
            "results": j["results"], "error": j["error"], "timings": j["timings"]}


@app.get("/api/jobs/{jid}/files/{name}")
def get_file(jid: str, name: str):
    if jid not in jobs or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise HTTPException(404, "Fichier introuvable.")
    p = DATA / jid / "files" / name
    if not p.is_file():
        raise HTTPException(404, "Fichier introuvable.")
    return FileResponse(p, media_type=MIME.get(p.suffix, "application/octet-stream"), filename=name,
                        content_disposition_type="attachment")
