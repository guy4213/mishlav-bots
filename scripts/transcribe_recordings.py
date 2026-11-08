"""Transcribe call recordings (Hebrew) locally with ivrit-ai Whisper.

Usage (from repo root):
    uv run --no-project --with faster-whisper --with "av<14" python -X utf8 scripts/transcribe_recordings.py [recordings_dir] [out_dir]
    (av<14: faster-whisper still passes `metadata_errors`, which PyAV 14 removed)

- Stereo calls (channel = one side of the call): one pass over the mix with word
  timestamps; each word goes to the louder channel -> "צד א" / "צד ב".
- If both channels carry the same audio, falls back to a single mixed track.
- Resumable: files that already have a transcript are skipped.
"""
import os
import sys
import time

import numpy as np
from faster_whisper import WhisperModel, decode_audio

MODEL = os.environ.get("WHISPER_MODEL", "ivrit-ai/whisper-large-v3-turbo-ct2")
SR = 16000
SIDE = {0: "צד א", 1: "צד ב", None: "דובר"}


def clean_name(fname: str) -> str:
    stem = os.path.splitext(fname)[0]
    # file names were extracted from a zip with broken encoding
    return stem.replace("╫£╫£╫נ-╫₧╫í╫ñ╫¿", "ללא-מספר")


def ts(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    return f"{m:02d}:{s:02d}"


def rms(x):
    return float(np.sqrt(np.mean(x * x))) if len(x) else 0.0


def process(model, path):
    """One Whisper pass over the mixed audio (word timestamps); each word is then
    attributed to the channel where it is louder -> half the compute of per-channel runs."""
    left, right = decode_audio(path, sampling_rate=SR, split_stereo=True)
    duration = len(left) / SR
    corr = float(np.corrcoef(left, right)[0, 1]) if left.std() > 0 and right.std() > 0 else 1.0
    stereo = corr < 0.9
    # normalize channels so a quiet line does not lose every word
    gl, gr = rms(left) or 1.0, rms(right) or 1.0
    ln, rn = left / gl, right / gr

    segs, _ = model.transcribe(
        (left + right) / 2,
        language="he",
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
        word_timestamps=True,
    )

    turns = []  # [start, end, channel, text]
    for s in segs:
        for w in s.words or []:
            text = w.word.strip()
            if not text:
                continue
            if stereo:
                a, b = int(w.start * SR), max(int(w.end * SR), int(w.start * SR) + 1)
                ch = 0 if rms(ln[a:b]) >= rms(rn[a:b]) else 1
            else:
                ch = None
            if turns and turns[-1][2] == ch and w.start - turns[-1][1] < 2.0:
                turns[-1][1] = w.end
                turns[-1][3] += " " + text
            else:
                turns.append([w.start, w.end, ch, text])
    return duration, ("stereo" if stereo else "mono"), turns


def main():
    rec_dir = sys.argv[1] if len(sys.argv) > 1 else "recordings"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "transcripts"
    os.makedirs(out_dir, exist_ok=True)

    files = [f for f in os.listdir(rec_dir) if f.lower().endswith((".mp3", ".wav", ".m4a", ".ogg"))]
    files.sort(key=lambda f: os.path.getsize(os.path.join(rec_dir, f)))  # short first
    todo = [f for f in files if not os.path.exists(os.path.join(out_dir, clean_name(f) + ".md"))]
    print(f"{len(files)} files, {len(todo)} to transcribe. Loading {MODEL} ...", flush=True)

    model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=int(os.environ.get("WHISPER_THREADS", "10")))

    for i, f in enumerate(todo, 1):
        t0 = time.time()
        name = clean_name(f)
        try:
            duration, mode, turns = process(model, os.path.join(rec_dir, f))
        except Exception as e:  # keep going on a bad file
            print(f"[{i}/{len(todo)}] FAILED {name}: {e}", flush=True)
            continue
        lines = [f"# {name}", "", f"- משך: {ts(duration)}", f"- ערוצים: {mode}", ""]
        lines += [f"**[{ts(s)}] {SIDE[ch]}:** {text}" for s, _, ch, text in turns] or ["_(אין דיבור)_"]
        tmp = os.path.join(out_dir, name + ".md.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write("\n\n".join(lines) + "\n")
        os.replace(tmp, os.path.join(out_dir, name + ".md"))
        print(f"[{i}/{len(todo)}] {name}  {ts(duration)} audio, {mode}, {time.time()-t0:.0f}s", flush=True)

    print("DONE", flush=True)


if __name__ == "__main__":
    main()
