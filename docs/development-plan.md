# Quiz maker development plan

Status: local 2.0.0 implementation in progress. Nothing in this version is published yet. Existing local command and accent fixes are included in this work. Repeated selections of 1 and 15 are counted once: 27 accepted features. Features 2 and 36 are optional.

## Product contract

Keep the ordinary flow short: choose notes or cards, choose a pack, preview, study. New quiz remains available with Extra commands off. Keep the existing Studio, generator, editor, study/mini view and settings sections. Advanced controls open beside the task; do not create a dashboard or settings page for every feature.

Retain React/TypeScript, native Obsidian controls, system fonts and local storage. Prefer Obsidian's renderer and export capabilities. Add a dependency only for a demonstrated capability gap, after checking mobile compatibility, license, maintenance and bundle cost. No remote fonts, decorative asset packs, telemetry, self-updates or automatic paid retries.

The engineering target is detectable, recoverable failure and factual review, not a promise that AI or software can never be wrong. Generated drafts must pass structural validation; uncertain evidence and quality heuristics must be labelled. Imported answers remain unchanged unless the user explicitly edits them.

## Phase 0: audit, cleanup and baseline

- Preserve the existing local command, settings, accent and documentation changes. Include them in the local 2.0.0 validation.
- Inventory public tracked files and their references. Remove only confirmed unused outputs, duplicate styles, dead code or obsolete assets after checking their purpose. No deletion has been performed in this planning audit.
- Keep source, meaningful regression tests, build/release scripts, MIT/dependency notices and documentation. Generated runtime files are installable build outputs, not source clutter; keep them excluded from source control and publish only the three supported runtime assets.
- app-icon.png, hero.png and icon.svg have active README/runtime uses. logo.svg appears unreferenced in the inspected runtime/docs; verify whether it remains a maintained editable brand source before proposing removal.
- Consolidate shared input, menu, error and theme primitives before adding controls. Preserve accessible focus, semantic colors, reduced motion and explicit component states.
- Verify scoped blue accents in native Obsidian and browser fixtures. Tested appearances do not establish compatibility with every community theme.
- Establish a clean baseline: 502 regression tests, official lint/typecheck, deterministic build, credential scans, dependency audit, native/mobile UI checks and current Obsidian review results. The development-only minimatch advisory is resolved with the pinned secure engine and lint compatibility tests.

## Shared data foundations

Question IDs are currently optional. Assign missing IDs once during migration/import. Preserve identity on reorder and metadata edits; duplicates and alternate versions get new IDs. Add a content revision so changing the answer cannot quietly retain stale grading or scheduling assumptions.

Keep session-local indices and immutable quiz snapshots. Centralize index/ID remapping. Introduce a validated, versioned storage migration with a verified pre-migration backup and an explicit unknown-version refusal. Do not silently downgrade new data through an old writer.

Current limits include a 32 MiB library, 200 quizzes, 100 results and 20,000 review cards. Results retain full session/quiz snapshots. Revisions, undo, question-bank entries and backups need byte budgets as well as count caps. Keep recent detailed replay separate from compact local trend aggregates. Never silently discard existing history during migration.

Use one shared bank/revision layer, one interchange pipeline and one diagnostic service. Do not duplicate the same question as several independently editable live objects. Quizzes pin question versions; active sessions retain their original snapshots. Portable exports remain self-contained.

## Accepted features

| ID | What will be created | Compact placement | Verification goal |
| --- | --- | --- | --- |
| 1 | Editable personal study packs containing formats, counts, difficulty, language and timing, with clear defaults and a readable summary. | Existing Study pack selector plus one edit sheet. | Save/reopen preserves values; invalid totals cannot generate. |
| 2 optional | A short source excerpt with a note link and locator, verified against the selected source text. | Collapsed Source disclosure beneath a revealed answer; hidden before exam submission. | Exact quote match or explicit unverified/missing status; no invented citation. |
| 3 | Shared quality diagnostics for malformed questions, conflicting answers, duplicates, missing options and unsupported source references. | One review summary with field-local issues. | Hard errors block saving; heuristics warn without claiming factual certainty. |
| 4 | Before/after preview for regenerated questions, with accept and discard actions. | Current Regenerate action opens a comparison. | The original survives cancellation, errors and rejected drafts. |
| 5 | Topic/difficulty exam blueprints with target counts and optional balanced allocation. | A disclosure in the pack editor. | Allocations sum correctly and unsupported requests are explained. |
| 6 | Local trends in accuracy, study time and weak tagged topics. | Results detail with an optional library link. | Totals match stored sessions; self-assessed answers are not presented as objectively graded. |
| 7 | Bidirectional Anki/Obsidian interchange, including field mapping, tags, cloze handling, media references, stable import IDs and a conversion report. | Existing Import/Export flows. | No silent card loss; supported types round-trip; conflicts and unsupported content are listed. |
| 8 | Local language suggestion from the selected text, with explicit manual override. | Existing Language field, not a new panel. | Mixed/uncertain language asks for a choice; no automatic translation. |
| 9 | Generate from the current editor selection, retaining its note and text locator. | Command and editor context action. | Only selected text is sent; no hidden expansion to the whole note. |
| 15 | Alternate quiz versions from the same blueprint, with independent IDs and a shared variant family. | Quiz actions menu. | Answers stay attached after randomization; source limits still apply; genuinely new wording requires generation/review. |
| 16 | A searchable question bank with explicit reuse into quiz drafts. | Quizzes/Questions view selector in the existing library. | Editing a bank entry cannot silently change an active session or pinned quiz version. |
| 17 | Question tags and filters for topic, course or learning objective. | One filter disclosure and a small tag editor. | Tags survive import, export, duplication and bulk edits. |
| 18 | Bounded restorable content revisions with preview. Existing provenance-only revision records are not sufficient for restoration. | Versions inside quiz details. | Restore creates a new valid revision and preserves the current version for recovery. |
| 19 | Transactional bulk tag/difficulty/remove operations with a preview of affected questions. | Temporary toolbar shown only during selection. | All-or-nothing validation; failed writes do not leave partial edits. |
| 20 | Bounded undo/redo for editor transactions, including removals and accepted replacements. | Small editor controls and standard shortcuts. | Undo restores question order, answers, tags and revision references without repeating API calls. |
| 24 | PDF export of questions, optional answer key and print-friendly layout. This selection is PDF export, not PDF source import. | Export menu. | Test equations, code, images and page breaks; verify desktop/mobile export paths before promising parity. |
| 25 | Explicit local image attachments with preview, alt text, size limits and missing-file handling. | Insert image within question details. | No automatic remote downloads or arbitrary vault reads; no unapproved image upload to AI. |
| 26 | LaTeX math editing and preview through Obsidian's existing mathematical renderer, plus Anki delimiter conversion where supported. | Inline/display math in the current editor preview. | Formula fixtures render consistently; malformed or active commands stay safe and visible. No bundled TeX installation. |
| 27 | Better code presentation, preserved indentation/language labels and contained scrolling. | Existing question renderer. | Code stays inert; model-generated fences never invoke another plugin's executable code processor. |
| 36 optional | A small, searchable shortcut reference based on available commands. | Help menu, hidden during ordinary practice. | Keyboard operation works and the guide does not claim a hardcoded shortcut overrides user hotkeys. |
| 37 | One-handed mobile layout with safe-area support and reachable answer/navigation actions. | Existing full and mini study views. | Check 280/320/390 px widths, landscape, soft keyboard and real device behavior. |
| 38 | A focus mode that hides secondary controls while keeping progress, answering and exit accessible. | One study-view menu option. | No lost session state; keyboard and screen-reader paths remain available. |
| 42 | Approximate request-size/output estimates, with warnings for oversized notes or question mixes. | One line near Generate. | Label estimates as estimates; do not present an exact bill without verified provider pricing and actual usage. |
| 47 | Known-good local backup rotation, migration backup and restore preview with explicit retention limits. | Existing recovery area/settings disclosure. | Verify writes before replacing live data; simulate disk failures, damaged backups and interrupted restores. Exclude API keys from shareable backups. |
| 48 | A reproducible theme/layout compatibility matrix covering native and supported community-theme scenarios. | Development fixtures and tests, not user-facing controls. | No purple accent leakage in tested blue themes, clipped menus, overflow or invisible focus; keep reduced motion and contrast. |
| 49 | A release gate covering tests, native checks, privacy, manifests, licenses, three assets, provenance, deterministic builds and current directory review. | Existing release workflow/check scripts. | A failed required check blocks publication; never label unrun or external checks as passed. |
| 50 | English README tutorials: short written setup, overview video and focused task clips with transcripts/captions. | One guide index and lightweight video posters. | Demonstrate the actual released UI using public sample notes; narration matches real behavior. ElevenLabs and After Effects are production tools for documentation, not plugin dependencies. |

## Anki compatibility contract

Treat an Anki note and its generated cards as distinct records: one note can produce reversed or multiple cloze cards. Preserve deck/note-type/field/tag identities and keep an import manifest so repeat imports can preview updates instead of multiplying duplicates.

Start with UTF-8 TSV/CSV import and export, mapping/preview and explicit media selection. Then implement selected APKG import/export with a published compatibility matrix, bounded archive extraction and mobile-capable parsing. Evaluate library dependencies before selecting them. TSV is an immediately useful interchange path, not a substitute for the accepted packaged-deck target.

Target Basic, reversed, typed-answer and Cloze first; then media/image-occlusion and custom-template cases. Retain original fields and account for every source card: converted, preserved with a limited preview, or explicitly unsupported. Do not execute imported JavaScript or inject deck-wide CSS into Obsidian. Do not silently claim that an image-occlusion card or custom interactive template became an equivalent ordinary multiple-choice question.

Keep original scheduling/history as optional preserved metadata initially. Do not claim it transfers unchanged into Quiz maker's different scheduler or enable automatic two-way synchronization without a separate conflict model. Never replace a user's Anki collection through a collection-package import.

Anki uses different MathJax delimiters from Obsidian. Convert supported expressions structurally, preserve custom macros as metadata where necessary, and flag unsupported compiled-LaTeX behavior. Reuse provided rendered media where appropriate. No automatic system TeX installation or imported-code execution.

References: [Anki text import](https://docs.ankiweb.net/importing/text-files.html), [export](https://docs.ankiweb.net/exporting.html), [packaged decks](https://docs.ankiweb.net/importing/packaged-decks.html), [math](https://docs.ankiweb.net/math.html).

## Implementation order and gates

0. Stabilize pending commands/theme fixes, remove only proven waste, and verify the real native baseline.
1. Establish identities, storage migration, bounded revisions/undo/backups and shared diagnostics. Test old libraries and round trips before UI expansion.
2. Build packs/blueprints, selection generation, optional evidence, language suggestions, quality review, replacement preview, variants and size estimates.
3. Add the bank, tags, transactional bulk editing and compact local trends on the shared data foundation.
4. Add safe local media, LaTeX/code polish, TSV/CSV interchange, then the APKG compatibility work and PDF export. Each adapter has explicit fixtures and loss reporting.
5. Complete mobile/focus/optional-shortcut UX. Accessibility and responsive checks run during earlier phases too.
6. Capture the verified English guides and pass the full release/directory review gate.

Each phase ends with a working, reviewable increment. The user has approved 2.0.0 development across these features; unfinished adapters or checks must remain explicitly marked before any release. No feature gets a permanent toolbar button unless it is a frequent primary action.

## Verification record

Local 2.0.0 checks completed:

- 620 automated tests pass on Linux and Windows, including pack/preferences retention, migration/storage, generation, editor and adapter cases.
- Typecheck, official lint with zero warnings, source policy and local release checks pass. Three builds produced matching runtime files, and the Windows build matched the Linux build byte for byte. These checks do not publish a release or establish Obsidian Community approval.
- The full development and runtime dependency audit reports zero vulnerabilities. The pinned minimatch 11.0.1 engine uses a small, tested compatibility adapter for the official lint toolchain.
- Targeted interchange and UI tests cover quoted CSV/TSV, legacy SQLite packages and modern compressed schema-18 Basic/Cloze fixtures. Optional package image attachment and retained original fields/scheduling are implemented. Native Anki application verification remains pending.
- Chromium checks exercised custom-pack save/generate, a 390px study layout with 44px touch targets and no horizontal overflow, mini view and searchable source-evidence settings with the default off. This is a tested subset, not the entire theme/device matrix.

All 20 native Playwright workflow cases pass against the current build installed in Another Vault, using public fixtures and isolated study storage. Native Google model discovery returned 34 selectable models after correcting the Obsidian import boundary. No note text, private keys or paid-generation requests were needed for that metadata check; it does not establish generation access to every model.

Native Windows PDF export and cancellation are verified. The nine-page, 677,070-byte PDF contains 35 embedded images; extracted image inspection confirms complete E=mc² and summation glyphs and a local image attachment without the earlier clipping. Output remains image-backed and is not searchable/selectable or accessible screen-reader text. Physical mobile PDF saving remains unverified.

The 84.39-second English tutorial is complete at `docs/media/quiz-maker-2.0-tutorial.mp4`, with a JPG poster, WebVTT captions and Markdown transcript. Video/audio decode, caption and visual checks pass. It is a narrated walkthrough of actual native still captures with public Solar System notes, a demonstration provider and local Microsoft Zira narration. README and guide link the assets.

The user has authorized GitHub publication after final QA and documentation/media review. No publication is claimed here. Native Anki application checks, physical-device tests, broader community-theme coverage and external Obsidian directory review remain separate.

## Definition of done

- Existing quizzes, notes, explicit preferences and credentials remain intact; migrations and restore paths are tested.
- AI failures, invalid JSON, unsupported Anki content and missing media are recoverable and explained beside the affected action.
- Generation does not happen automatically during browsing, validation, search, import or undo.
- No credentials in source, release assets, screenshots, logs or portable exports.
- No runtime Node/Electron dependency on mobile; heavy optional adapters must justify and respect the bundle budget.
- No priority CSS or relational selectors introduced to bypass review; use scoped tokens, ordinary selectors and explicit component state.
- No claims of zero hallucinations, universal Anki equivalence, native/mobile success or Obsidian approval without the corresponding evidence.
