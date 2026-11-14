"""Озвучивает фразы мастера голосом Baldur Sanjin (Coqui XTTS-v2) с проверкой распознаванием.

Запуск (в окружении с coqui-tts, faster-whisper, librosa, ffmpeg):
    COQUI_TOS_AGREED=1 python tools/voice/generate.py
Лицензия модели XTTS-v2 — Coqui Public Model License, только некоммерческое использование.
Уже озвученные фразы пропускаются; manifest.json пишется после каждой фразы.
"""
import difflib, json, os, re, subprocess, sys, tempfile, time
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf
import torch
from TTS.api import TTS
from faster_whisper import WhisperModel

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('VOICE_OUT', ROOT / 'docs' / 'audio'))
PHRASES = json.loads(Path(os.environ.get('VOICE_PHRASES', ROOT / 'tools' / 'voice' / 'phrases.json')).read_text(encoding='utf-8'))
SPEAKER = 'Baldur Sanjin'
SPEED = 0.9
TRIES = 6

torch.set_num_threads(os.cpu_count() or 4)
OUT.mkdir(parents=True, exist_ok=True)
man_path = OUT / 'manifest.json'
manifest = json.loads(man_path.read_text()) if man_path.exists() else {}
manifest.setdefault('voice', f'{SPEAKER}, Coqui XTTS-v2 (CPML, некоммерческая лицензия)')
clips = manifest.setdefault('clips', {})
report = manifest.setdefault('check', {})

tts = TTS('tts_models/multilingual/multi-dataset/xtts_v2').to('cpu')
asr = WhisperModel('small', device='cpu', compute_type='int8')

NUMW = {'0': 'ноль', '1': 'один', '2': 'два', '3': 'три', '4': 'четыре', '5': 'пять', '6': 'шесть', '7': 'семь',
        '8': 'восемь', '9': 'девять', '10': 'десять', '11': 'одиннадцать', '12': 'двенадцать', '103': 'сто три'}

def norm(t):
    t = t.lower().replace('ё', 'е')
    t = re.sub(r'\d+', lambda m: ' ' + NUMW.get(m.group(0), m.group(0)) + ' ', t)
    t = re.sub(r'[^a-zа-я0-9 ]+', ' ', t)
    return re.sub(r'\s+', ' ', t).strip()

def transcribe(wav, sr):
    y = librosa.resample(wav, orig_sr=sr, target_sr=16000)
    segs, _ = asr.transcribe(y, language='ru', beam_size=1, condition_on_previous_text=False, word_timestamps=True)
    words = [w for s in segs for w in (s.words or [])]
    return ' '.join(w.word.strip() for w in words), words

def score(text, wav, sr):
    heard, words = transcribe(wav, sr)
    want = norm(text).split()
    got = norm(heard).split()
    # Лишний звук в конце: распознано больше слов, чем сказано, — отрезаем хвост после последнего нужного слова.
    if len(got) > len(want) and len(words) >= len(want) and want:
        cut = int(min(len(wav), (words[len(want) - 1].end + 0.15) * sr))
        tail_ok = difflib.SequenceMatcher(None, ' '.join(want), ' '.join(got[:len(want)])).ratio()
        if tail_ok > 0.7 and cut < len(wav):
            wav = wav[:cut]
            heard, words = transcribe(wav, sr)
            got = norm(heard).split()
    sim = difflib.SequenceMatcher(None, ' '.join(want), ' '.join(got)).ratio()
    extra = max(0, len(got) - len(want))
    dur = len(wav) / sr
    n = len(text)
    hi = 1.3 + n * 0.11
    lo = n * 0.035
    ok_len = lo <= dur <= hi
    return sim - 0.15 * extra - (0 if ok_len else 0.5), sim, heard, dur, wav

def clean(wav, sr):
    wav = np.asarray(wav, dtype=np.float32)
    y, _ = librosa.effects.trim(wav, top_db=38, frame_length=1024, hop_length=256)
    pad = np.zeros(int(sr * 0.06), dtype=np.float32)
    y = np.concatenate([pad, y, pad])
    peak = np.max(np.abs(y)) or 1.0
    return y * (0.89 / peak)

todo = [p for p in PHRASES if not (p['key'] in clips and (OUT / f"{p['key']}.mp3").exists())]
print(f'{len(PHRASES)} фраз, осталось {len(todo)}', flush=True)
sr = 24000
for idx, p in enumerate(todo, 1):
    text, key = p['text'], p['key']
    t0 = time.time()
    best = None
    need = 0.9 if len(text) > 14 else 0.75
    for attempt in range(TRIES):
        torch.manual_seed(1000 + attempt * 37 + idx)
        wav = tts.tts(text=text, speaker=SPEAKER, language='ru', speed=SPEED, temperature=0.65 if attempt < 3 else 0.5)
        y = clean(wav, sr)
        s, sim, heard, dur, y = score(text, y, sr)
        y = clean(y, sr)
        if best is None or s > best[0]:
            best = (s, sim, heard, dur, y, attempt + 1)
        if s >= need:
            break
    s, sim, heard, dur, y, tries = best
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        sf.write(f.name, y, sr)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f.name, '-ac', '1', '-ar', '24000',
                        '-codec:a', 'libmp3lame', '-b:a', '48k', str(OUT / f'{key}.mp3')], check=True)
        os.unlink(f.name)
    clips[key] = round(dur, 2)
    report[key] = {'text': text, 'heard': heard.strip(), 'sim': round(sim, 2), 'tries': tries, 'ok': s >= need}
    man_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=0), encoding='utf-8')
    flag = '' if s >= need else '  <-- проверить'
    print(f'[{idx}/{len(todo)}] {time.time() - t0:4.0f}s sim={sim:.2f} x{tries} {text[:60]}{flag}', flush=True)
print('готово', flush=True)
