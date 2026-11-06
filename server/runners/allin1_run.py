import json, sys
from pathlib import Path
from allin1 import analyze

audio, demix, spec = sys.argv[1], sys.argv[2], sys.argv[3]
r = analyze(Path(audio), out_dir=None, demix_dir=Path(demix), spec_dir=Path(spec),
            device="cpu", multiprocess=False, keep_byproducts=True)
r = r[0] if isinstance(r, list) else r
print(json.dumps({
    "bpm": int(r.bpm) if r.bpm is not None else None,
    "beats": len(r.beats), "downbeats": len(r.downbeats),
    "segments": [{"start": round(s.start, 2), "end": round(s.end, 2), "label": s.label} for s in r.segments],
}))
