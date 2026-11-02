# Quiz maker design

The default interface follows Obsidian, with optional local palettes and the folded-card mark from the README. A question and its next action take priority over toolbars, metadata, and decoration.

## Themes

| Appearance | Background | Text | Primary action |
| --- | --- | --- | --- |
| Obsidian | Vault theme | Vault theme | Vault accent |
| Paper | Cool white #f7f9fd | Navy #182641 | Blue #245bd2 |
| Midnight | Navy #101a2d | #edf3ff | Blue #2f6bdb |
| High contrast | Dark navy #0d1423 | White | Pale blue #a8c8ff |

Obsidian is the default for new settings. Existing explicit appearance choices are preserved. Obsidian follows the vault's surfaces, fonts and accent. Settings always use the native host appearance; optional palettes apply to quiz views. Correct answers, errors, and timer warnings keep their semantic colors and text labels.

Theme variables live on .qm-root. For explicitly selected Paper, Midnight and High contrast palettes, control variables are overridden within that root. The default Obsidian appearance inherits the host variables. The only external selector targets exported question callouts carrying both data-callout="question" and the qm-quiz metadata marker. Unrelated notes and callouts keep the vault theme.

## Typography and controls

Use the configured Obsidian interface and text fonts. The fallback stack uses the device's system UI font, including Segoe UI and Roboto. Do not download fonts or add a font dependency. Interface text is 15px, reading text is 16px, and prompts scale from 18px (17px in narrow panes) with the host’s reading text. Small metadata uses 12–13px. Reading width stays near 70 characters; code scrolls inside its own block.

Spacing follows a 4px rhythm. Buttons and labelled choices have at least a 44px touch height. Icon buttons retain accessible names and tooltips; icons support an action rather than replace necessary instructions. Focus uses a visible outline from the selected appearance. Maintain readable text and control contrast in every palette. Preserve supplied primary-button text when its contrast passes 4.5:1; otherwise choose black or white without changing the accent background. Handle normal and hover states separately, keep disabled labels unchanged and defer to forced colours. Owned-root CSS-change bindings must clean up. Inherited community themes still require their own visual checks.

Native button appearance is reset within the plugin. Grid buttons explicitly stretch their tracks and align text to the start, preventing the host's centered button layout from affecting study packs.

## Layout

Each default screen follows one task. Use one primary action, one compact toolbar and at most one route to secondary controls. Do not restore separate rows for mode, progress, position and view tools. Advanced functions remain available without occupying the initial surface.

The library opens as Your quizzes, New quiz, search and plain quiz rows. Each row shows title, question count, Study and a local action menu. Library tools opens import, manual writing, question bank, saved packs, history, trends, backups and note tools. Secondary pages have Back to quizzes. Bank and backup components mount on first entry and remain hidden when navigating away so pending actions and errors survive.

Creation is one column, capped at 760px: selected notes, study pack with question count, Generate quiz. Show short note names, with full paths available on demand and duplicate names disambiguated. One Add source control offers Add note and Add folder through the native menu. Keep folder access beside the sources. Note/folder pickers stop at 560px, fit the viewport and retain 44px controls. One Customize disclosure contains flat groups for formats, preferences, additional sources and configured models. Missing connection setup remains visible. Validation errors and the data-destination sentence stay outside collapsed controls. Do not add parallel Question mix, More options and Model accordion bands.

Study setup shows the mode, question count and Start. Timing, shuffle, pause, appearance and editing live in Study options; saved timed configurations open those controls. During study, one toolbar contains the current-position/jump control, active timer and Options. The question follows immediately. Check answer becomes Next after checking; deliberate skipping is in Options. Back appears after the first question. Focus mode retains its own exit and the position control.

The study modal stops at 760px. Its content and footer share a reading column near 72 characters. Below 700px window height the footer flows under the content so it cannot cover choices. Feedback, reference and explanation form one answer block. Results begin with the outcome and next action; statistics, trends and answer browsing open under Review answers.

Mini view uses title/open-full, one position/timer/options row, the question and a state-aware primary action. Back appears after the first question. Pause, finishing, flags and focus stay in Options. Optional sources follow the revealed reference; avoid separate stacks of repeated feedback labels.

The editor keeps title and Tools together, a question list, the current question and one Save quiz action. JSON, history, quiz metadata, export and Save and study are under Tools. Add question and bulk management open on request. Import/export dialogs stop at 640px; the two-pane editor retains 1120px on wide screens.

Settings remain native. General shows appearance and motion, with optional sounds and command preferences under one More options disclosure. Test sound appears only when sounds are enabled. Quizzes keeps pack, language and note folder visible; format and evidence are optional. Model provider, required credential/server information and the chosen model remain clear. Discovery opens on request, manual IDs remain available, and errors stay visible. Existing searchable settings and saved defaults are preserved. Advanced connection fields stay within their existing group.

At 600px and below, dialogs use the available width and respect safe areas. At 380px and below, groups wrap. Inputs use 16px text on narrow screens. Long text and JSON must not widen their container. Keep keyboard destinations visible when menus close or actions disappear.

## Motion and verification

Use 140ms control transitions and a 160ms entrance for questions and revealed answers. Animate opacity and transforms, never layout dimensions or timer digits. Both system reduced motion and the plugin setting suppress animation, including nested quiz roots and press transforms. Keyboard-initiated checking and flashcard ratings move focus to feedback or the next card; passive mini-view updates do not take focus. There is no continuous background animation.

Check all four appearances, keyboard focus, long prompts, code, errors, empty states, settings panes, mini view, forced colors, and widths of 280, 320, 390, 768px and desktop. Documentation screenshots must show the installed plugin with public demo content.

New quiz and Quick quiz are default commands alongside Open. Both open setup with the active Markdown note and saved study pack, without reading or sending its content until Generate. Other commands stay optional. Source selection browses only the current folder and folders the user opens; it does not build a vault-wide path index.
