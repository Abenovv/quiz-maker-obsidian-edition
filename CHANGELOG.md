# Release notes

## 1.0.0

Initial independent release of Quiz maker.

- Create quizzes from selected notes or folders, import JSON, or write questions manually.
- Choose an editable study pack, including Student pack, Quick recall, and Exam prep.
- Study with practice, timed practice, exams, flashcards, and review sessions.
- Use seventeen question formats with readable answers and source references.
- Save quizzes as readable notes with structured data for reopening.
- Preview compatible library backups and import new quizzes without overwriting existing ones.
- Discover available provider models, enter a model ID, and cancel generation.
- Choose an Obsidian, Paper, Midnight, or High contrast interface.

Install `main.js`, `manifest.json`, and `styles.css` in `.obsidian/plugins/quiz-maker/`, then reload Obsidian and enable Quiz maker.

Provider accounts and API charges are controlled by the selected service. Imported quizzes, manual questions, and local Ollama generation provide alternatives to hosted generation. Review generated answers before using them.

`SHA256SUMS` records the three installable file hashes. The release workflow also creates a signed build-provenance attestation. Verify a downloaded file with:

```sh
gh attestation verify main.js --repo Abenovv/quiz-maker-obsidian-edition
```

Build provenance identifies the repository and workflow that produced a file. It is not a security audit or Obsidian Community directory approval.
