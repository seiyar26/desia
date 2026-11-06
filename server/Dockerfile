FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive UV_LINK_MODE=copy UV_PYTHON_INSTALL_DIR=/opt/python PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ffmpeg libsndfile1 build-essential ninja-build \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /usr/local/bin/uv

# 1) orchestrateur + librosa
RUN uv venv --python 3.12 /venvs/main && \
    uv pip install --python /venvs/main/bin/python fastapi==0.115.6 "uvicorn[standard]==0.34.0" \
      python-multipart==0.0.20 psutil==6.1.1 librosa==0.10.2.post1 numpy==1.26.4 soundfile==0.12.1

# 2) allin1 + demucs (torch CPU 2.5.1, natten 0.17.3 (compilé), madmom)
RUN uv venv --python 3.10 /venvs/allin1
COPY constraints-allin1.txt /tmp/constraints-allin1.txt
RUN uv pip install --python /venvs/allin1/bin/python -c /tmp/constraints-allin1.txt \
      torch==2.5.1 torchaudio==2.5.1 --default-index https://pypi.org/simple --index https://download.pytorch.org/whl/cpu
RUN uv pip install --python /venvs/allin1/bin/python -c /tmp/constraints-allin1.txt cython setuptools wheel numpy ninja packaging
RUN apt-get update && apt-get install -y --no-install-recommends cmake && rm -rf /var/lib/apt/lists/*
RUN NATTEN_N_WORKERS=8 MAX_JOBS=8 uv pip install --python /venvs/allin1/bin/python -c /tmp/constraints-allin1.txt --no-build-isolation natten==0.17.3
RUN uv pip install --python /venvs/allin1/bin/python -c /tmp/constraints-allin1.txt \
      cython && \
    uv pip install --python /venvs/allin1/bin/python -c /tmp/constraints-allin1.txt --no-build-isolation \
      "madmom @ git+https://github.com/CPJKU/madmom.git@27f032e8947204902c675e5e341a3faf5dc86dae"
RUN uv pip install --python /venvs/allin1/bin/python -c /tmp/constraints-allin1.txt allin1==1.1.0 demucs==4.0.1 soundfile

# 3) essentia-tensorflow + modèles Discogs-EffNet
RUN uv venv --python 3.11 /venvs/essentia && \
    uv pip install --python /venvs/essentia/bin/python essentia-tensorflow "numpy<2"
COPY fetch_models.sh /tmp/fetch_models.sh
RUN sh /tmp/fetch_models.sh /models/essentia

# 4) basic-pitch
RUN uv venv --python 3.10 /venvs/bp && \
    uv pip install --python /venvs/bp/bin/python basic-pitch==0.4.0 "numpy<2" "setuptools<81"

# 5) Audio Flamingo 3
RUN uv venv --python 3.11 /venvs/flamingo && \
    uv pip install --python /venvs/flamingo/bin/python torch==2.7.1 torchaudio==2.7.1 --default-index https://pypi.org/simple --index https://download.pytorch.org/whl/cpu && \
    uv pip install --python /venvs/flamingo/bin/python "transformers>=4.57" accelerate librosa soundfile sentencepiece protobuf

WORKDIR /app
COPY app.py /app/app.py
COPY runners /app/runners
ENV HF_HOME=/cache/hf TORCH_HOME=/cache/torch XDG_CACHE_HOME=/cache/xdg DATA_DIR=/data
EXPOSE 8790
CMD ["/venvs/main/bin/uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8790", "--workers", "1"]
