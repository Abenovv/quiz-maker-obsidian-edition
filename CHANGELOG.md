# Release notes

## 1.2.1

Open Quiz maker through one command, then choose the action you need.

- Show **Quiz maker: Open** as the single default palette command. Enable **Extra commands** in General settings to use individual actions and their existing hotkeys.
- Group creation under **Create quiz** and note actions under **Tools**. Keep study packs and recent sessions collapsed until needed.
- Combine defaults and saved-note options under **Quizzes**, alongside **General** and **Models** settings.
- Preselect the active Markdown note when creating from notes. Model discovery still starts only when requested.
- Keep the question mix, additional options, and configured model behind disclosures while retaining all seventeen question formats.
- Keep library rows focused on **Study**, with editing in the actions menu. Simplify editor actions and keep export in JSON view or the library menu.

Existing provider settings, quizzes, and study history stay in their local files. The release contains only the installable plugin files and verification material.

## 1.2.0

Fix model discovery failures and simplify provider setup.

- Fix model lookup failing before it contacts the provider in some Obsidian environments.
- Accept Ollama server addresses with or without an `/api` suffix for discovery and generation.
- Keep completion-capable Ollama models with custom names that broad keyword filters previously excluded.
- Use one **Find models** action with searchable results and a manual **Model ID** field.
- Cancel outdated lookups when connection details change, and show more specific discovery errors.
- Report successful settings saves correctly even if an open view cannot refresh.
- Offer language suggestions while keeping custom language entry, and show the loaded plugin version in settings.

Model discovery reads metadata only; it does not send note text or generate questions. Provider keys remain in local settings and are excluded from release files.

## 1.1.0

The study interface now follows Quiz maker's blue identity, with clearer controls and less visual clutter.

- Apply blue accents across Obsidian, Paper, Midnight, and High contrast; Midnight now uses dark navy surfaces.
- Simplify quiz setup, navigation, and action groups, with consistent icons and shorter labels.
- Refine the mini view and settings for narrow panels, long text, and keyboard use.
- Require an answer before checking a question in the mini view, matching the full study view.
- Keep timer updates within the window that owns the study view, including Obsidian popouts.
- Keep paused sessions paused when reopening the full view, and update the mini view when appearance settings change.
- Keep the confirmed provider and endpoint fixed while a generation request is running.
- Preserve bookmarks and review cards when a quiz is edited during a session, and stop queued storage changes after shutdown.
- Fix selecting the vault root as a source folder.
- Reduce unnecessary borders and spacing, retain vault and system fonts, and respect reduced motion.
- Remove duplicate titles and format captions from newly saved readable notes.
- Refresh native Obsidian screenshots and remove asset-download links from the README footer.

Update the three release files in `.obsidian/plugins/quiz-maker/`, then reload Obsidian. Provider keys and study data stay in their separate local files; they are not included in the release.

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
