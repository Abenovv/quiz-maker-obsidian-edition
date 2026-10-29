# Quiz maker design

The interface uses navy surfaces, a blue accent, and the folded-card mark from the README. A question and its next action take priority over toolbars, metadata, and decoration.

## Themes

| Appearance | Background | Text | Primary action |
| --- | --- | --- | --- |
| Obsidian | Vault theme | Vault theme | Blue #245bd2 |
| Paper | Cool white #f7f9fd | Navy #182641 | Blue #245bd2 |
| Midnight | Navy #101a2d | #edf3ff | Blue #2f6bdb |
| High contrast | Dark navy #0d1423 | White | Pale blue #a8c8ff |

Midnight is the default for new settings. Existing appearance choices are preserved. Obsidian follows the vault's surfaces while using the same blue actions. Correct answers, errors, and timer warnings keep their semantic colors and text labels.

Theme variables live on .qm-root. Obsidian's control variables are overridden within that root so native toggles, checkboxes, and buttons use the plugin accent. The only external selector targets exported question callouts carrying both data-callout="question" and the qm-quiz metadata marker. Unrelated notes and callouts keep the vault theme.

## Typography and controls

Use the configured Obsidian interface and text fonts. The fallback stack uses the device's system UI font, including Segoe UI and Roboto. Do not download fonts or add a font dependency. Interface text is 15px, reading text is 16px, and prompts use 17–18px. Small metadata uses 12–13px. Reading width stays near 70 characters; code scrolls inside its own block.

Spacing follows a 4px rhythm. Buttons and labelled choices have at least a 44px touch height. Icon buttons retain accessible names and tooltips; icons support an action rather than replace necessary instructions. Focus uses a visible blue outline. Custom-theme primary text contrast is at least 4.7:1; text on hovered surfaces is at least 5.18:1. Custom control boundaries are at least 3.12:1 on their surrounding surfaces.

Native button appearance is reset within the plugin. Grid buttons explicitly stretch their tracks and align text to the start, preventing the host's centered button layout from affecting study packs.

## Layout

The studio uses divided library rows and short study packs. Keep primary creation actions in the header, secondary actions quiet, and the current session easy to resume. Avoid a separate box for every label or status.

Session setup uses a mode selector with one description. Timing stays beside it; shuffle and pause settings sit in a disclosure. During practice, question navigation opens on demand. The question has a readable content column and the footer separates navigation from answering. Reference answers use a small semantic border rather than a nested stack of cards.

The mini view shares the same session and controls at 280px. Its navigation uses two compact labelled buttons and a pause icon. Results, finishing, and error recovery stay in the same panel. Native settings use container queries so fields stack inside a narrow settings pane even when the overall window is wide.

At 600px and below, dialogs use the available width and respect safe areas. At 380px and below, packs form one column and footer groups wrap. Inputs use 16px text on narrow screens to avoid mobile browser zoom. Long text and JSON must not widen their container.

## Motion and verification

Use 140ms control transitions and a 160ms entrance for questions and revealed answers. Animate opacity and transforms, never layout dimensions or timer digits. Both system reduced motion and the plugin setting suppress animation. There is no continuous background animation.

Check all four appearances, keyboard focus, long prompts, code, errors, empty states, settings panes, mini view, forced colors, and widths of 280, 320, 390, 768px and desktop. Documentation screenshots must show the installed plugin with public demo content.
