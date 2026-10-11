# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "soundfile>=0.12", "onnxruntime>=1.17"]
# ///
"""DNSMOS P.835 (SIG / BAK / OVRL) — non-intrusive speech quality, Microsoft DNS Challenge model.

usage: uv run dnsmos.py --wav FILE.wav [--models DIR]
Input: mono 16 kHz wav (the TS caller resamples). Model sig_bak_ovr.onnx is downloaded once into --models
(default quality/.cache/models). Mirrors DNSMOS/dnsmos_local.py: 9.01 s windows, 1 s hop, polynomial mapping
of raw outputs (non-personalised). Prints JSON {sig, bak, ovrl, windows}.
"""
import argparse
import json
import os
import sys
import urllib.request

import numpy as np
import soundfile as sf

MODEL_URL = "https://github.com/microsoft/DNS-Challenge/raw/master/DNSMOS/DNSMOS/sig_bak_ovr.onnx"
SR = 16000
INPUT_LENGTH = 9.01

P_OVR = np.poly1d([-0.06766283, 1.11546468, 0.04602535])
P_SIG = np.poly1d([-0.08397278, 1.22083953, 0.0052439])
P_BAK = np.poly1d([-0.13166888, 1.60915514, -0.39604546])


def model_path(models_dir):
    os.makedirs(models_dir, exist_ok=True)
    path = os.path.join(models_dir, "sig_bak_ovr.onnx")
    if not os.path.exists(path):
        print(f"downloading DNSMOS model → {path}", file=sys.stderr)
        tmp = path + ".part"
        urllib.request.urlretrieve(MODEL_URL, tmp)
        os.replace(tmp, path)
    return path


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", required=True)
    ap.add_argument("--models", default=os.path.join(here, "..", ".cache", "models"))
    a = ap.parse_args()

    import onnxruntime as ort  # noqa: PLC0415

    audio, sr = sf.read(a.wav, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != SR:
        raise SystemExit(f"DNSMOS needs {SR} Hz input, got {sr}")
    sess = ort.InferenceSession(model_path(a.models), providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    need = int(INPUT_LENGTH * SR)
    while len(audio) < need:
        audio = np.append(audio, audio)
    hops = int(np.floor(len(audio) / SR) - INPUT_LENGTH) + 1
    sig, bak, ovr = [], [], []
    for i in range(hops):
        seg = audio[i * SR : i * SR + need]
        if len(seg) < need:
            continue
        raw = sess.run(None, {name: seg[np.newaxis, :].astype("float32")})[0][0]
        sig.append(P_SIG(raw[0]))
        bak.append(P_BAK(raw[1]))
        ovr.append(P_OVR(raw[2]))
    print(json.dumps({"sig": float(np.mean(sig)), "bak": float(np.mean(bak)), "ovrl": float(np.mean(ovr)), "windows": len(sig)}))


if __name__ == "__main__":
    main()
