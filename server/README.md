# Serveur d'analyse avancée Dés-IA

API FastAPI dans un conteneur Docker (`desia-api`), derrière Caddy :
`https://desia.72-60-44-179.sslip.io` → `127.0.0.1:8790`.

## Routes

- `POST /api/jobs` (multipart : `file`, `describe=1` en option) → `202 {"id"}`. Erreurs : 413 (> 100 Mo), 415 (audio illisible ou > 10 min), 429 (4 analyses en file ou en cours).
- `GET /api/jobs/{id}` → `{id, status, position, step, steps_done, results, error}` (+ `timings` : durée et mémoire de pointe par étape).
- `GET /api/jobs/{id}/files/{vocals,drums,bass,other}.flac` et `notes.mid`.
- `GET /api/health`.

Les analyses passent une par une (6 threads, `nice`). Les dossiers de travail sont supprimés 1 h après la fin, et au démarrage du conteneur.

## Outils (un environnement uv par outil)

| Outil | Version | Licence |
|---|---|---|
| librosa | 0.10.2.post1 | ISC |
| Essentia (TF) | 2.1b6.dev1389 | AGPL-3.0 ; modèles Discogs-EffNet et têtes : CC BY-NC-SA 4.0 |
| Demucs (htdemucs) | 4.0.1 | MIT |
| all-in-one | 1.1.0 (natten 0.17.3, madmom git 27f032e) | MIT ; madmom : BSD, modèles CC BY-NC-SA |
| Basic Pitch | 0.4.0 (tflite) | Apache-2.0 |
| Audio Flamingo 3 | `nvidia/audio-flamingo-3-hf`, transformers 5.22.1, torch 2.7.1 | NVIDIA non commercial |

Usage non commercial uniquement tant que les modèles CC BY-NC-SA et Audio Flamingo sont utilisés.

## Déploiement (VPS `lexi`)

```sh
rsync -az --delete server/ lexi:/opt/desia-api/
ssh lexi 'cd /opt/desia-api && docker compose up -d --build'
```

Audio Flamingo (≈ 17 Go) : le téléchargement via `huggingface_hub` bloque depuis ce VPS. Le pré-charger une fois dans le volume `desia-cache` avec `curl` vers `/cache/af3` (config, tokenizer et 4 fichiers `model-0000N-of-00004.safetensors` de `https://huggingface.co/nvidia/audio-flamingo-3-hf/resolve/main/`). Sans ce dossier, le runner retombe sur le Hub.

Mesures sur un titre de 2 min 41 (8 cœurs, 6 alloués au conteneur, sans GPU) : Demucs 120 s, puis all-in-one 136 s (ses 8 réseaux tournent chacun dans son processus, ≈ 6,5 Go de RAM au pic) ; librosa 41 s, Essentia 8 s et Basic Pitch 34 s tournent pendant Demucs. Audio Flamingo ajoute ≈ 313 s (≈ 19 Go de RAM). Total ≈ 4 min 30 sans description, ≈ 10 min avec.
