# Serigraph: Brand System v2

The brand book. Strategy first, then the system. Reversals of any decision
here are explicit, never drift. v1 (paper, Fraunces, press-room) is retired;
it lives in git history. The name and its meaning stay; everything else was
rebuilt for one reason: Serigraph is infrastructure for agents and the
consultants who direct them, and the identity had to look the part.

---

## 1. The name

**Serigraph** /ˈser.ɪ.ɡræf/: Latin *sericum* (silk) + Greek *graphein* (to
write). A fine-art screenprint: one image, pulled through many screens, in
exact register. Usage: capitalized, one word, never "Serigraph AI" or "SG".
The internal `opsmap` namespace remains an implementation detail only.

## 2. Strategy (brandkit § Brand Strategy First)

- **Category:** agent-native operations infrastructure. The operating model
  of a business as one machine-readable file.
- **Audience:** AI-automation consultants first; operators and technical
  founders second. People who sell trust and read diffs.
- **Emotional promise:** certainty. Nothing is fabricated, unknown is never
  zero, and the file never lies.
- **Core metaphor:** **the master plate.** In screen printing, every
  impression comes from one master. In Serigraph, every view (Map, Brief,
  Roadmap, Audit) and every agent is an impression pulled from one file.
  There is no second source to drift.
- **Cultural position:** not a diagram tool. Infrastructure. The control
  room, not the gallery.
- **Avoid:** paper/craft nostalgia (v1's world), AI-purple gradients,
  sparkles, "seamless", mascot energy, dashboard cosplay.

**Brand idea in one line:** *One file. Every impression.*

## 3. The mark: "Register"

September 5, 2026: the user's logo replacement supersedes both the old
three-node app icon and the previously documented Stack direction.

Two identical solid ribbons, in half-turn symmetry, form an interlocking S.
Broad curves and precise diagonal cuts reference printing layers in register;
the clear central channel keeps the mark readable at toolbar size.

The production source is [app/serigraph-mark.svg](../app/serigraph-mark.svg):
a `32×32` viewBox, one path and its rotated instance, in signal emerald
`#3DDC97`. The header uses a `22×22` box; the favicon shares the same source.
Standalone exports embed it, so branding needs no network connection.

- Keep the two ribbons identical and preserve their spacing.
- Use a single solid color; no outlines, gradients, shadows or animation.
- For monochrome reproduction, use one contrasting ink for the whole mark.
- Keep at least four viewBox units of external clear space.

The initial direction was explored with built-in ImageGen, then reconstructed
as a small native SVG for the app. Creative brief: an emerald S made from
interlocking printing ribbons, precise negative space, legible at 24px.
This is a visual identity direction, not a trademark-clearance claim.

**Wordmark:** "Serigraph" in Clash Display 600, tight tracking (−0.02em),
ink. Lockup: mark left, wordmark right, cap-height aligned. The wordmark
never appears in the hero headline type at smaller than 20px.

## 4. Color

One palette, dark-first. The product's home is the control room.

| Token | Hex | Role | On base |
|---|---|---|---|
| `base` | `#060708` | Page ground, OLED neutral | |
| `surface` | `#0C0E11` | Cards, inner cores | |
| `glass` | `rgba(255,255,255,.04)` | Shell fills | |
| `line` | `rgba(255,255,255,.08)` | Hairlines | |
| `line-strong` | `rgba(255,255,255,.14)` | Active hairlines | |
| `ink` | `#F2F5F7` | Primary text | 18.4:1 |
| `muted` | `#A7AEB8` | Secondary text | 9.0:1 |
| `faint` | `#6B7380` | Metadata, large/short only | 4.2:1 |
| `signal` | `#3DDC97` | Emerald: interactive, savings, go | 11.4:1 |
| `signal-deep` | `#17A673` | Emerald borders, glow base | 6.5:1 |
| `amber` | `#F0B04E` | Provenance, doubt, caution | 10.6:1 |
| `on-signal` | `#06110C` | Text on emerald fills | 10.9:1 |

Rules:

- **One accent carries the system:** emerald is the only interactive color.
  Amber is semantic (doubt) and never decorative. No third hue, ever.
- Node-type inks in diagrams (product continuity, dark-theme values):
  process `#6AA2F8`, decision `#E8A33D`, system `#A988EC`, role `#46C393`,
  artifact `#93A5BA`. Diagrams may use them; chrome may not.
- Mesh-gradient atmosphere: emerald orb at ≤ 12% alpha, teal orb at ≤ 8%.
  No purple. The orbs sit behind glass, never over text.
- Shadows carry the background hue; emerald glow only on primary CTAs and
  only as a tight inner/hairline glow, never a neon halo.
- No pure `#000` and no pure `#FFF` text.

## 5. Typography

| Role | Face | Weights | Fallback |
|---|---|---|---|
| Display / wordmark | **Clash Display** (Fontshare) | 500, 600 | "Space Grotesk", system sans |
| Text / UI | **Geist** | 400, 500, 600 | system sans |
| File / figures | **Geist Mono** | 400, 500, 600 | ui-monospace |

Inter is retired everywhere. Rules:

- Headlines: Clash Display 600, tracking −0.02em, `text-wrap: balance`,
  sentence case. Sizes fluid (`clamp`), section heads 34-56px, hero to 96px.
- Body: Geist 400, 16.5-18px, line-height 1.6, measure ≤ 60ch,
  `text-wrap: pretty`.
- Anything from the file (YAML, ids, commands, dollar figures) is Geist
  Mono with `tabular-nums`.
- Eyebrow pills: Geist 500, 10.5-11px, uppercase, tracking 0.18em, inside a
  pill chip, maximum one per section.

## 6. Voice

Unchanged in spirit from v1, tighter in register: declarative, concrete,
numbers over adjectives. The one permitted flourish is the print metaphor,
used once per page at most ("One file. Every impression."). Banned:
revolutionary, seamless, supercharge, empower, unlock, elevate, delve,
"game-changer", exclamation marks in body copy, em-dashes in headlines.

## 7. Surface & component language (soft-skill translation)

The site's physicality comes from **machined glass**, not paper:

- **Double-bezel everywhere.** Every card, frame, or input is an outer shell
  (`glass` fill, `line` hairline, 6-8px padding, 24-32px radius) around an
  inner core (`surface` fill, inset top highlight, radius = outer − padding).
  Nothing premium sits flat on the background.
- **Buttons are pills with an island.** Primary CTAs are emerald pills; a
  trailing arrow never sits naked. It lives in its own circular wrapper
  flush with the button's inner padding, and slides diagonally on hover.
- **Ambient shadows, massively diffused** (20-60px blur, ≤ 12% alpha, hue-
  tinted). Never `shadow-md`, never generic gray.
- **Grain:** one fixed `pointer-events-none` noise veil at ~4%, never on a
  scrolling container.
- **Blur** (`backdrop-blur`) only on fixed layers: the floating nav pill,
  the mobile menu overlay. Never on scrolling content.

## 8. Motion principles

Custom easings only: `cubic-bezier(0.32, 0.72, 0, 1)` for entrances,
`cubic-bezier(0.22, 1, 0.36, 1)` for settles. No `linear`, no
`ease-in-out`, nothing instant.

- **Scroll interpolation:** elements enter with `translateY(24px)` + slight
  blur + fade, resolving over 700-900ms, staggered ≤ 80ms. Once only.
- **Magnetic buttons:** scale to 0.98 on press; the icon island travels on
  hover. No color-only hovers.
- **The mark stays static** (see §3). The odometer stats roll once
  (per-digit wheels, staggered stops, plain values for AT/print).
- **Everything collapses to fully-present static content** under
  `prefers-reduced-motion` and on print.

## 9. Application

- **Site:** dark glass, asymmetric bento, macro-whitespace (`py-24`+),
  floating island nav. The old paper site is retired.
- **App:** keeps its functional workbench UI; the Register mark uses emerald
  in its top bar. No glass, no orbs there.
  The press room stays utilitarian.
- **Exports:** standalone HTML exports carry the mark and the line
  "Printed by Serigraph: one file, every impression."
- **Favicon:** the Register mark, emerald on a transparent ground.
- **OG image spec:** base ground, Register mark center-left, wordmark,
  tagline, one emerald orb behind glass.

### Do / Don't

**Do:** one emerald; glass with double bezels; mono for the file; sparse
type; huge air; motion with mass.

**Don't:** AI-purple or mesh-rainbow gradients; neon glows; Inter;
generic 1px gray borders; edge-to-edge glued navbars; symmetrical 3-column
feature rows; linear easing; anything that loops.

---

*The one-sentence test for new work: does it make the file more valuable as
the single machine-readable description of how the business runs? The
identity exists to make that sentence believable at a glance.*
