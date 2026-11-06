import os
import json, sys, time, torch
from transformers import AutoProcessor, AudioFlamingo3ForConditionalGeneration

audio = sys.argv[1]
MODEL = "/cache/af3" if os.path.isfile("/cache/af3/config.json") else "nvidia/audio-flamingo-3-hf"
PROMPT = ("Describe this track briefly: genre, instruments, mood, structure and production quality. "
          "Be factual and concise (at most 5 sentences).")
torch.set_num_threads(6)
t = time.time()
processor = AutoProcessor.from_pretrained(MODEL)
model = AudioFlamingo3ForConditionalGeneration.from_pretrained(MODEL, torch_dtype=torch.bfloat16, low_cpu_mem_usage=True).eval()
print(f"load {time.time()-t:.0f}s", file=sys.stderr, flush=True)
conv = [{"role": "user", "content": [{"type": "text", "text": PROMPT}, {"type": "audio", "path": audio}]}]
inputs = processor.apply_chat_template(conv, tokenize=True, add_generation_prompt=True, return_dict=True)
inputs["input_features"] = inputs["input_features"].to(torch.bfloat16)
t = time.time()
with torch.inference_mode():
    out = model.generate(**inputs, max_new_tokens=200)
print(f"generate {time.time()-t:.0f}s", file=sys.stderr, flush=True)
text = processor.batch_decode(out[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0].strip()
print(json.dumps({"text": text}))
