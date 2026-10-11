# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy>=1.26", "soundfile>=0.12", "pesq>=0.0.4"]
# ///
"""Full-reference audio scorer for the Clearcall quality lab.

usage: uv run audio_score.py --ref REF.wav --deg DEG.wav [--mode speech|music] [--segment 8]
Both files mono, same sample rate (the TS caller resamples with ffmpeg: 16 kHz for speech, 48 kHz for music).
The reference may loop inside the received recording (Chrome's fake audio capture loops the file), so the
reference is tiled and every segment of the degraded signal is aligned by FFT cross-correlation first.

Prints one JSON object:
  speech: pesq_wb (mean over segments), pesq_wb_min, segments, delay_ms, corr
  music:  snr_db (gain-optimal segmental SNR), lsd_db (log-spectral distance), segments, delay_ms, corr
"""
import argparse
import json
import sys

import numpy as np
import soundfile as sf


def load(path):
    x, sr = sf.read(path, dtype="float64", always_2d=True)
    return x.mean(axis=1), sr


def xcorr_lag(a, b):
    """Lag L maximising sum a[n+L]*b[n] (FFT). a is the longer (search) signal. Returns (lag, normalised peak)."""
    n = len(a) + len(b)
    nfft = 1 << (n - 1).bit_length()
    c = np.fft.irfft(np.fft.rfft(a, nfft) * np.conj(np.fft.rfft(b, nfft)), nfft)[: len(a) - len(b) + 1]
    lag = int(np.argmax(c))
    seg = a[lag : lag + len(b)]
    denom = np.sqrt(np.sum(seg**2) * np.sum(b**2)) + 1e-12
    return lag, float(c[lag] / denom)


def tiled(ref, length):
    reps = int(np.ceil(length / len(ref))) + 1
    return np.tile(ref, reps)[:length]


def align_segments(ref, deg, sr, seg_s, search_s=0.5):
    """Yield (ref_seg, deg_seg, offset_in_ref, corr) for consecutive deg segments."""
    seg = int(seg_s * sr)
    search = int(search_s * sr)
    big = tiled(ref, len(deg) + len(ref) + 2 * search + seg)
    # Global offset from the first (up to) 10 s of deg against one full loop + margin.
    probe = deg[: min(len(deg), 10 * sr)]
    base, corr0 = xcorr_lag(big[: len(ref) + len(probe)], probe)
    for start in range(0, len(deg) - seg + 1, seg):
        d = deg[start : start + seg]
        if np.sqrt(np.mean(d**2)) < 1e-4:
            continue  # silence (DTX / muted) — nothing to score
        lo = max(0, base + start - search)
        window = big[lo : lo + seg + 2 * search]
        lag, corr = xcorr_lag(window, d)
        off = lo + lag
        yield big[off : off + seg], d, off % len(ref), corr
    yield None, None, base % len(ref), corr0


def score_speech(ref, deg, sr, seg_s):
    from pesq import pesq  # noqa: PLC0415

    if sr not in (16000,):
        raise SystemExit("speech scoring needs 16 kHz input (PESQ-WB)")
    scores, corrs, delay = [], [], 0
    for r, d, off, corr in align_segments(ref, deg, sr, seg_s):
        if r is None:
            delay = off
            continue
        if np.sqrt(np.mean(r**2)) < 1e-3:
            continue  # reference is silence here
        try:
            scores.append(float(pesq(sr, r, d, "wb")))
            corrs.append(corr)
        except Exception as e:  # NoUtterancesError etc.
            print(f"segment skipped: {e}", file=sys.stderr)
    if not scores:
        return {"error": "no scorable speech segments"}
    return {
        "pesq_wb": float(np.mean(scores)),
        "pesq_wb_min": float(np.min(scores)),
        "segments": len(scores),
        "delay_ms": round(1000 * delay / sr, 1),
        "corr": float(np.mean(corrs)),
    }


def score_music(ref, deg, sr, seg_s):
    snrs, lsds, corrs, delay = [], [], [], 0
    nfft, hop = 2048, 512
    win = np.hanning(nfft)
    for r, d, off, corr in align_segments(ref, deg, sr, seg_s):
        if r is None:
            delay = off
            continue
        g = float(np.dot(r, d) / (np.dot(d, d) + 1e-12))  # gain-optimal: compare shape, not level (AGC)
        err = r - g * d
        snrs.append(10 * np.log10((np.sum(r**2) + 1e-12) / (np.sum(err**2) + 1e-12)))
        frames = range(0, len(r) - nfft, hop)
        pr = np.array([np.abs(np.fft.rfft(win * r[i : i + nfft])) ** 2 for i in frames]) + 1e-10
        pd = np.array([np.abs(np.fft.rfft(win * g * d[i : i + nfft])) ** 2 for i in frames]) + 1e-10
        lsds.append(float(np.mean(np.sqrt(np.mean((10 * np.log10(pr / pd)) ** 2, axis=1)))))
        corrs.append(corr)
    if not snrs:
        return {"error": "no scorable music segments"}
    return {
        "snr_db": float(np.mean(snrs)),
        "lsd_db": float(np.mean(lsds)),
        "segments": len(snrs),
        "delay_ms": round(1000 * delay / sr, 1),
        "corr": float(np.mean(corrs)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--deg", required=True)
    ap.add_argument("--mode", choices=["speech", "music"], default="speech")
    ap.add_argument("--segment", type=float, default=8.0)
    a = ap.parse_args()
    ref, sr1 = load(a.ref)
    deg, sr2 = load(a.deg)
    if sr1 != sr2:
        raise SystemExit(f"sample rates differ: {sr1} vs {sr2}")
    if len(deg) < a.segment * sr1:
        raise SystemExit(f"degraded signal shorter than one segment ({a.segment} s)")
    fn = score_speech if a.mode == "speech" else score_music
    print(json.dumps(fn(ref, deg, sr1, a.segment)))


if __name__ == "__main__":
    main()
