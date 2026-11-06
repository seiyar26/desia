import json, multiprocessing as mp, os, sys
from pathlib import Path

import torch
from allin1 import analyze
from allin1.models.ensemble import Ensemble
from allin1.typings import AllInOneOutput

# Le modèle « harmonix-all » moyenne 8 réseaux. allin1 les passe l'un après l'autre
# et leurs opérations (NATTEN) n'occupent qu'un cœur : on calcule chaque réseau dans
# son propre processus (fork, modèles partagés en copie sur écriture), même moyenne.
WORKERS = int(os.environ.get("ALLIN1_WORKERS", "8"))
_shared = {}


def _forward_one(i):
    torch.set_num_threads(1)
    with torch.no_grad():
        o = _shared["models"][i](_shared["x"])
    return o.logits_beat, o.logits_downbeat, o.logits_section, o.logits_function, o.embeddings


def parallel_forward(self, x):
    _shared["models"], _shared["x"] = self.models, x
    with mp.get_context("fork").Pool(min(WORKERS, len(self.models))) as pool:
        outputs = pool.map(_forward_one, range(len(self.models)))
    beat, downbeat, section, function, embeddings = zip(*outputs)
    return AllInOneOutput(
        logits_beat=torch.stack(beat, dim=0).mean(dim=0),
        logits_downbeat=torch.stack(downbeat, dim=0).mean(dim=0),
        logits_section=torch.stack(section, dim=0).mean(dim=0),
        logits_function=torch.stack(function, dim=0).mean(dim=0),
        embeddings=torch.stack(embeddings, dim=-1),
    )


Ensemble.forward = parallel_forward

audio, demix, spec = sys.argv[1], sys.argv[2], sys.argv[3]
r = analyze(Path(audio), out_dir=None, demix_dir=Path(demix), spec_dir=Path(spec),
            device="cpu", multiprocess=False, keep_byproducts=True)
r = r[0] if isinstance(r, list) else r
print(json.dumps({
    "bpm": int(r.bpm) if r.bpm is not None else None,
    "beats": len(r.beats), "downbeats": len(r.downbeats),
    "segments": [{"start": round(s.start, 2), "end": round(s.end, 2), "label": s.label} for s in r.segments],
}))
