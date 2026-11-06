import json, sys
import numpy as np, librosa

y, sr = librosa.load(sys.argv[1], sr=None, mono=True)
tempo = librosa.beat.beat_track(y=y, sr=sr)[0]
tempo = float(np.atleast_1d(tempo)[0])
n_fft = 4096
S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=2048)) ** 2
P = S.mean(axis=1)
freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
db = 10 * np.log10(np.maximum(P, 1e-20))
above = np.where(db >= db.max() - 60)[0]
cutoff = float(freqs[above.max()])
hf = P[freqs >= 16000].sum()
hf_db = float(10 * np.log10(max(hf, 1e-20) / P.sum()))
mag = np.sqrt(S)
out = {
    "tempo": round(tempo, 2),
    "centroid_hz": round(float(librosa.feature.spectral_centroid(S=mag, sr=sr).mean()), 1),
    "rolloff_hz": round(float(librosa.feature.spectral_rolloff(S=mag, sr=sr, roll_percent=0.99).mean()), 1),
    "bandwidth_hz": round(float(librosa.feature.spectral_bandwidth(S=mag, sr=sr).mean()), 1),
    "flatness": round(float(librosa.feature.spectral_flatness(S=mag).mean()), 5),
    "cutoff_hz": round(cutoff, 1),
    "hf_energy_db": round(max(hf_db, -120.0), 2),
}
print(json.dumps(out))
