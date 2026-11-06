import json, sys
import pretty_midi
from basic_pitch.inference import predict

audio, midi_out = sys.argv[1], sys.argv[2]
_, midi, notes = predict(audio)
midi.write(midi_out)
pitches = [n[2] for n in notes]
out = {"notes": len(pitches)}
if pitches:
    out["lowest"] = pretty_midi.note_number_to_name(min(pitches))
    out["highest"] = pretty_midi.note_number_to_name(max(pitches))
print(json.dumps(out))
