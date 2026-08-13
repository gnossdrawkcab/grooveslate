FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MUSIC_ROOT=/music \
    DATA_ROOT=/data \
    MSST_ROOT=/opt/msst

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg git libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/app
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && pip install bs-roformer-infer \
    && git clone --depth 1 https://github.com/ZFTurbo/Music-Source-Separation-Training.git /opt/msst \
    && pip install librosa soundfile ml-collections omegaconf tqdm matplotlib

COPY app ./app

EXPOSE 8095
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8095"]
