# B. Letterpress

**Concept.** Swiss stationery printed in one ink: a single oxblood colour on uncoated stock, a strict 12-column grid, crop marks around the printed card, and the amount set as the largest thing on the page. When the loop closes, a circular seal is pressed into the card (debossed, with the invoice number and date running round the ring) instead of a stamp being inked on. Restraint is the point: no second colour, no decoration beyond rules, so the seal is the only event.

**Type** (two families, both SIL OFL, self-hosted in `fonts/`)
- Archivo 400/500/700/800 for words and the large amount; tight negative tracking at display sizes, tabular figures turned on globally.
- Red Hat Mono 400/500 for hashes, times, addresses and small figures.

**Palette** (all one ink at different strengths; dark tokens defined)

| Token | Light | Dark |
|---|---|---|
| `--stock` | `#efeee9` | `#1c1214` |
| `--card` | `#f8f7f3` | `#24171a` |
| `--ink` | `#6b1a25` | `#f0d9d6` |
| `--ink-80` | `#7f3a43` | `#d9b8b6` |
| `--ink-60` | `#96585f` | `#b78f90` |
| `--hair-strong` (non-text) | `#b99599` | `#6a4a4f` |

Measured WCAG contrast: ink on stock 10.04, ink on card 10.89, ink-80 on stock 6.98, ink-60 on card 5.08, ink-60 on stock 4.69, button text (card on ink) 10.89. Dark: ink on stock 13.61, ink-80 on card 9.47, ink-60 on card 6.06.

**Motion.** The three stations (Payment on Base, Match on Reactive Network, Settlement on Base) light up in order from 25% to full ink, 700 ms apart, then the seal presses: it appears at 1.08x, dips to 0.97x and settles (420 ms). The deboss is two 1 px drop shadows, light below and dark above. Reduced motion shows the final state.

**Print.** A4, chrome and payment controls dropped, crop marks kept, seal printed flat, full hashes after links.

**Borrows from.** Swiss and German business stationery, one-colour letterpress jobs, notary and embossing seals, printer's crop marks. No brand referenced.

**Screens.** `index.html`, `pay.html` (`?state=paid` for the closed loop), `state.html` (invoice expired: hatched void card, "do not send money", late payments are recorded and passed to the treasury but mark nothing paid). Screenshots at 360, 768, 1440.
