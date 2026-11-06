# usage: demucs_run.py audio.wav demix_dir  -> demix_dir/htdemucs/<stem>/{vocals,drums,bass,other}.wav
import json, sys
from demucs.separate import main
audio, out = sys.argv[1], sys.argv[2]
main(["-n", "htdemucs", "-d", "cpu", "-j", "1", "--out", out, audio])
print(json.dumps({"ok": True}))
