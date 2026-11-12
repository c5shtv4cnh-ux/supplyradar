# Design system

The web app (`src/frontend`) is plain HTML, CSS and JavaScript. Everything visual is driven by the
tokens at the top of `styles.css`, so a new screen is built from existing parts rather than new CSS.

## Principles

1. **Clarity first.** One primary (coral) action per screen. Page title says where you are, the first
   card says what to do next. Problems are written out in words next to the field they concern.
2. **Calm by default.** Working screens sit on a flat navy field with no texture or glow. Motion is one
   200 ms fade per navigation; nothing loops except progress indicators. Coral appears only for the next
   action and for money that is leaking.
3. **Accessible to everyone.** Target: WCAG 2.2 AA (see the checklist below).
4. **Built to scale.** Colours, radii and type are tokens; sizes are in `rem`; components are named
   classes reused across screens (`.card`, `.button`, `.chip`, `.badge`, `.toolbar`, `table.responsive`).

## Tokens

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--navy` / `--cream` / `--coral` | `#14213d` / `#f4ede0` / `#ff6b5b` | same | brand constants |
| `--surface`, `--surface-2` | `#fffcf6`, `#f7f0e3` | `#14213d`, `#1a2a4c` | cards, table headers |
| `--text`, `--muted` | `#14213d`, `#5b6377` | `#f4ede0`, `#a4aec4` | body and secondary text (both >= 4.5:1) |
| `--control-border` | `#8a8170` | `#7f8db0` | borders of inputs and buttons (>= 3:1) |
| `--border`, `--border-strong` | `#e4dac7`, `#cdc1aa` | `#25355a`, `#3a4b72` | decorative dividers only |
| `--accent`, `--accent-text` | coral, navy | same | primary button (5.6:1) |
| `--accent-ink`, `--rise` | `#bf321c` | `#ff9486` | coral when it has to be text |
| `--fall`, `--warn`, `--info` (+ `-bg`) | | | status colours, always paired with a word or symbol |
| `--radius-sm/-/-lg` | 10 / 14 / 20 px | | inputs / small blocks / cards |

Type: Onest variable (300-700), self-hosted with Cyrillic. Body `1rem`, small `0.8125rem`, page title
`2.75rem` weight 400, landing headline up to `4.75rem` weight 300.

## Accessibility checklist (WCAG 2.2 AA)

| Criterion | How it is met |
| --- | --- |
| 1.4.1 Use of colour | Price changes carry an arrow, a sign and hidden text; flagged fields have a written reason; chart series differ by line pattern; links are underlined |
| 1.4.3 / 1.4.11 Contrast | Text >= 4.5:1, control borders and focus ring >= 3:1, in both themes and on the landing hero |
| 1.4.4 / 1.4.10 Resize and reflow | `rem` sizes; no horizontal scroll at 320 px (checked in `a11y.mjs`) |
| 1.4.12 Text spacing | No fixed-height text containers |
| 2.1.1 Keyboard | Every control is reachable, including the file pickers (visually hidden, not `display:none`) |
| 2.2.1 / 2.2.2 Timing and motion | Error toasts stay until dismissed; no auto-playing decorative motion; `prefers-reduced-motion` removes the rest |
| 2.4.1 / 2.4.2 / 2.4.3 | Skip link, per-page `<title>`, focus moves to the page heading on navigation |
| 2.4.7 / 2.4.11 Focus | Two-tone ring visible on any background; `scroll-padding` keeps focus clear of the sticky bars |
| 2.5.8 Target size | All targets >= 24 px, most >= 40 px (44 px on phones) |
| 3.3.1 / 3.3.3 Errors | Inline `role="alert"` messages that name the field and the fix |
| 3.3.8 Accessible authentication | Password managers and paste work (`autocomplete` set, no CAPTCHA) |
| 4.1.2 Name, role, value | Native elements; toggles use `aria-pressed`; current page uses `aria-current` |

Also honoured: `prefers-color-scheme`, `prefers-contrast: more`, forced-colours mode (focus uses `outline`).

## Checking

```bash
python3 tests/e2e/fake_backend.py &
node tests/e2e/ui.spec.mjs        # behaviour + screenshots
npm i --no-save axe-core && node tests/e2e/a11y.mjs   # axe on every screen, both themes, 320 px
```

axe cannot judge text over gradients, so the landing hero colours were checked by hand: the worst case
(secondary text over the brightest part of the coral light) is about 4.8:1; the headline is about 5.9:1.
