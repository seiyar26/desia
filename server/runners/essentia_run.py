import json, os, sys
import numpy as np
import essentia
essentia.log.infoActive = False
essentia.log.warningActive = False
import essentia.standard as es

M = "/models/essentia"
path = sys.argv[1]

a44 = es.MonoLoader(filename=path, sampleRate=44100)()
bpm, _, _, _, _ = es.RhythmExtractor2013(method="multifeature")(a44)
key, scale, strength = es.KeyExtractor()(a44)
a16 = es.MonoLoader(filename=path, sampleRate=16000, resampleQuality=4)()
emb = es.TensorflowPredictEffnetDiscogs(
    graphFilename=f"{M}/discogs-effnet-bs64-1.pb", output="PartitionedCall:1")(a16)

def head(name):
    meta = json.load(open(f"{M}/{name}-discogs-effnet-1.json"))
    sch = meta["schema"]
    pred = es.TensorflowPredict2D(graphFilename=f"{M}/{name}-discogs-effnet-1.pb",
                                  input=sch["inputs"][0]["name"], output=sch["outputs"][0]["name"])(emb)
    return meta["classes"], pred.mean(axis=0)

def prob(name, cls):
    classes, p = head(name)
    return round(float(p[classes.index(cls)]), 3)

classes, p = head("genre_discogs400")
top = np.argsort(p)[::-1][:3]
out = {
    "bpm": round(float(bpm), 2), "key": key, "scale": scale,
    "key_strength": round(float(strength), 3),
    "danceability": prob("danceability", "danceable"),
    "genres": [{"label": classes[i], "prob": round(float(p[i]), 3)} for i in top],
    "moods": {
        "happy": prob("mood_happy", "happy"), "sad": prob("mood_sad", "sad"),
        "aggressive": prob("mood_aggressive", "aggressive"),
        "relaxed": prob("mood_relaxed", "relaxed"), "party": prob("mood_party", "party"),
    },
}
print(json.dumps(out))
