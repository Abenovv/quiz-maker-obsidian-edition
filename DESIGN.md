# Quiz maker design

Quiz maker is a study workspace inside Obsidian. Its identity is a folded question card with a check, supported by quiet teal, clear type, and useful space. It does not imitate Obsidian's gem or use decorative gradients.

## Surfaces and themes

All interface styles stay inside `.qm-root`. Modal hosts use `.qm-root.qm-modal`; the React content sits in `.qm-app-shell`. Theme and motion preferences are `data-theme` and `data-motion` on that root.

| Theme | Background | Text | Accent |
| --- | --- | --- | --- |
| Obsidian | Vault theme | Vault theme | Vault theme |
| Paper | `#f5f3ec` | `#272b29` | `#246557` |
| Midnight | `#171d20` | `#edf3ef` | `#9bd5c1` |
| Contrast | `#101416` | `#ffffff` | `#b4f4de` |

Theme colors are provided through `--qm-bg`, `--qm-surface`, `--qm-surface-alt`, `--qm-surface-hover`, `--qm-text`, `--qm-muted`, `--qm-accent`, `--qm-accent-hover`, `--qm-on-accent`, `--qm-border`, `--qm-positive`, `--qm-danger`, `--qm-warning`, and `--qm-focus`. Status always has a text label or icon as well as color.

Use `--qm-control-border` for form controls and selectable choices; it is stronger than the quiet grouping divider. The custom themes provide at least 4.5:1 text contrast and 3:1 control-boundary contrast.

## Type and rhythm

Use the vault's interface and content fonts; bundle no fonts and request none from the network. Interface text is 15px, reading text is 16px, and question prompts are 18px. Native text zoom and accessible vault fonts remain usable. Long prose is limited to 72 characters per line.

Spacing steps are 4, 8, 12, 16, 20, 24, 32, and 40px. Corner radii are 6px for controls, 10px for grouped content, and 14px for the desktop modal. Use dividers and space to organize library rows; reserve a bordered surface for content that needs grouping.

## Interaction

Primary buttons use the theme accent and a clear verb. Secondary actions use a quiet border or no border. Controls are at least 40px high on desktop and 44px on narrow screens. All interactive elements receive a visible 2px keyboard focus ring.

Labels sit above form fields. Keep instructions beside the choice they explain, and show errors near the relevant field. Generated answers, source details, and raw JSON are disclosures rather than default page content. Exam screens never expose reference answers before submission.

Motion is limited to 140ms control feedback and a 160ms, four-pixel entrance for content explicitly marked `.qm-enter`. No perpetual background motion, animated counters, magnetic controls, or confetti. Both the system setting and `data-motion="reduced"` suppress motion.

## Layout

Desktop modals fit within the viewport and use a restrained maximum width of 1120px. Content scrolls inside the modal, with focus and actions kept reachable. Side navigation may sit beside the question when useful; phone layouts place it behind an explicit control or in a compact strip.

At 600px and below, the modal fills the available width, loses its outer radius, and respects device safe areas. Inputs use 16px text to avoid unwanted mobile browser zoom. Long code scrolls within its own block and never expands the page.

## Verification

Check Paper, Midnight, and Contrast in addition to the inherited vault theme. Verify keyboard focus, long titles, code, mathematical content, errors, empty states, narrow screens, reduced motion, and forced colors. Use real rendered components with public fixtures for documentation screenshots.
