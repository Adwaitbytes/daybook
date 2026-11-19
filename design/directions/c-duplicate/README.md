# C. Duplicate book

**Concept.** A carbon-copy receipt book on its card backing: a numbered counterfoil stub, a perforation, the printed form in teal with entries typed in carbon blue, and a yellow office copy under every sheet. The receipt fills itself in like a typewriter, then a red dater stamp ("PAID" over a date band) thumps down. On the pay page the yellow sheet is the live carbon copy of the status, and the receipt below it tears along a perforated edge with the three linked transactions.

**Type** (two families, SIL OFL, self-hosted in `fonts/`)
- Barlow Condensed 400 to 700 for everything printed on the form: headings, labels, buttons.
- Courier Prime 400/700 for everything typed in: amounts, hashes, dates, the status log. Monospaced, so figures line up.

**Palette**

| Token | Value | Role |
|---|---|---|
| `--board` | `#c9b68f` | card backing behind the pad, with a light noise texture |
| `--board-ink` | `#2b2218` | text on the board |
| `--board-ink-2` | `#4c3e2c` | secondary text on the board |
| `--top` | `#fbfaf3` | top sheet |
| `--copy` | `#f0e48e` | yellow duplicate |
| `--form` | `#1c5955` | pre-printed form ink |
| `--form-2` | `#3f7470` | form rules and secondary labels |
| `--carbon` | `#252a69` | typed and carbon entries |
| `--stamp` | `#bf3128` | dater stamp, serial numbers |

Measured WCAG contrast: board-ink on board 7.86, board-ink-2 on board 5.20, form on top 7.69, form on copy 6.21, form-2 on top 5.09, carbon on top 12.44, carbon on copy 10.03, stamp red on top 5.45, button text (top on form) 7.69. Dark board tokens exist (`#2a241c` backing, sheets stay paper-coloured, like a real pad on a dark desk) but were not screenshotted.

**Motion.** Typed fields reveal with a `steps()` width animation, one step per character (about 35 ms each), in reading order; then the dater stamp drops from 1.6x and lands rotated -11 degrees (300 ms). The current status line's mark blinks like a cursor. Reduced motion shows the final state.

**Print.** A5, prints the invoice sheet and the torn-off receipt only; the yellow copy and log are dropped.

**Borrows from.** Duplicate receipt books and invoice pads with counterfoils, carbon paper, office dater stamps, kraft card backing. No brand referenced.

**Screens.** `index.html`, `pay.html` (`?state=paid`), `state.html` (part paid: 200.00 of 480.00 received on Arbitrum, balance 280.00 due on any chain, "PART PAID" dater). Screenshots at 360, 768, 1440.
