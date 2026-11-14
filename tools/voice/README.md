# Голос мастера

Все постоянные фразы занятий заранее озвучены голосом **Baldur Sanjin** (модель Coqui XTTS-v2,
лицензия Coqui Public Model License — только некоммерческое использование) и лежат в `docs/audio/`.
Фразы без записи (ответы мастера в чате) приложение произносит голосом телефона.

Обновить озвучку после правки текстов в `docs/js/course.js` или `docs/js/coach.js`:

```bash
node tools/voice/dump.mjs > tools/voice/phrases.json
COQUI_TOS_AGREED=1 python tools/voice/generate.py
```

Нужны пакеты `coqui-tts`, `faster-whisper`, `librosa`, `soundfile` и `ffmpeg`. Скрипт озвучивает только
новые фразы, каждое предложение отдельно, проверяет его распознаванием речи и обрезает посторонние
звуки в конце. Итог проверки каждой записи — в поле `check` файла `docs/audio/manifest.json`.
Записи фраз, которых больше нет в `phrases.json`, удаляются вручную.
