# Using Quiz maker

## Create your first quiz

1. Open **Quiz maker: Open studio** from the command palette.
2. Choose **Generate**, then select notes or folders.
3. Start with **Student pack** or another pack and check the question counts.
4. Choose a model in the plugin settings if you have not configured one.
5. Generate, review the questions, and start a study session.

To try the interface without a provider account, use the sample quiz, create questions in the editor, or import JSON.

Selected notes are sent only when you generate or regenerate questions. Choosing a folder includes its selected note contents, so check the source list first.

## Study packs

Packs are editable starting points. They do not change your provider, API key, or selected notes.

| Pack | Questions | Starting mode |
| --- | ---: | --- |
| Student pack | 10 | Practice |
| Quick recall | 6 | Flashcards |
| Exam prep | 12 | Exam, 20 minutes |
| Deep understanding | 10 | Practice |
| Language practice | 10 | Practice |
| Coding practice | 10 | Practice |
| Interview prep | 10 | Timed practice, 20 minutes |

Change the question mix, difficulty, hints, or explanations before generating. You can also change the study mode and timer when starting a session.

Set the default question language under **Questions → Language** in settings. Choose a suggestion or enter your own language.

## Answer and review

Practice lets you reveal feedback as you work. In Exam, hints and reference answers remain hidden until submission, and the timer cannot be paused. Closing an exam does not stop its deadline.

Flag a question to revisit it during the attempt. Bookmark a question to keep it for later review. Written answers use self-review and are excluded from the automatic objective score.

Flashcards use **Again**, **Good**, and **Easy** ratings to schedule later review. Ratings are not marked as objectively correct or incorrect.

Run **Quiz maker: Open mini view** to continue the active session in a compact panel. It shares the same answers and timer as the full study view. Answer a practice question before choosing **Check**; exam answers stay hidden until submission.

## Save a readable note

Save a quiz to keep its questions in your configured vault folder. The default question-callout format gives each question a collapsed answer, while hidden structured data preserves its format, source references, and session defaults. Settings also offer a spaced-repetition note format with `?` separators.

The visible questions remain readable when Quiz maker is disabled. To reopen the active note, run **Quiz maker: Open quiz from note**. Editing visible callout text does not update the hidden quiz data; use the quiz editor when changing a saved quiz.

Older `quiz-json` blocks render as readable questions. **Make quiz readable** converts quiz blocks in the active note while preserving surrounding content. Source editing can still display the original JSON until you convert it.

## Import and edit JSON

Use Import to paste JSON or choose a file. Imports accept up to **500 questions** and **2 MiB** per document.

This minimal question array is accepted and converted to the current document format:

```json
[
  {
    "type": "multiple-choice",
    "question": "Which data type stores true or false?",
    "options": ["Boolean", "Text", "Date"],
    "answer": 0
  },
  {
    "type": "true-false",
    "question": "A JSON object uses square brackets.",
    "answer": false
  }
]
```

Choice indexes start at zero. Multiple-answer questions use an array of indexes. Other question formats have additional fields, which the editor can create.

The current document format is `schemaVersion: 2`; older versioned documents are imported through the same validator. Export keeps the structured fields. On mobile, exports are saved as JSON files in your configured vault folder. Provider keys and settings are not part of a quiz.

Validation catches missing fields, invalid indexes, broken paths, and malformed JSON. Review generated content for factual accuracy before studying it.

### Bring over a library

Import also accepts compatible library backups with a `library` list containing quiz `document` entries. Choose the backup yourself; Quiz maker does not read another plugin's files automatically.

The preview lists the quiz titles, new and existing quizzes, and entries that cannot be read. Confirm **Import** to add the valid new quizzes. Existing quizzes are skipped, so an older backup cannot overwrite your current edits. The original backup stays unchanged.

Library backups can be up to **32 MiB** and contain up to **200 quizzes**. Only quizzes are imported. Provider settings, API keys, session history, and review schedules are not migrated. Keep the backup private rather than attaching it to a bug report.

## Models and generation errors

In the **Models** settings:

1. Choose your provider and enter its API key when required.
2. Select **Find models** to load the models available to that account or server.
3. Search the results and choose a model, or enter its exact **Model ID** manually.

Model discovery requests metadata only. It does not send note content or generate questions. A manual model ID remains usable if discovery fails or your server does not offer a compatible model list.

| Situation | What to check |
| --- | --- |
| Authentication fails | Confirm the provider, endpoint, and API key. |
| A model is unavailable | Use **Find models** or enter a model ID enabled for your account. |
| Model listing is unsupported | A server may return 404 or 405 for discovery. Enter the exact **Model ID** manually. |
| Usage or rate limit reached | Check the provider's usage page and retry when its limit permits. |
| Response is incomplete or invalid | Request fewer questions or less source material, then try again. |
| A local model cannot be reached | Check that Ollama is running and its address is reachable. Addresses with or without an `/api` suffix are accepted. |
| Study data cannot be saved | Keep the current quiz open, inspect the storage error, and retry or export before closing. |

Cancel stops the local generation workflow. A provider may already be processing the request, so cancellation does not guarantee that its usage charge is avoided.

## Data and appearance

Settings, including provider keys, are stored locally in `data.json`. Study data is stored in `study.json`. Neither file is encrypted by Quiz maker or included in a release.

Choose Obsidian, Paper, Midnight, or High contrast in Appearance. Each uses a blue accent. Obsidian keeps the vault's surfaces and fonts; Midnight uses a dark navy background. Fonts are provided by your system and vault, with no font download.

Sound is optional and off by default. Motion can follow your system setting or stay reduced.

When reporting a problem, include the plugin version shown at the bottom of settings, Obsidian version, device, and a small example with private content removed. Do not attach API keys, local settings, or study-history files.
