Design System: "Technical Blueprint"

Version: 1.3 (Harmonized Violet & Refined Type)

Status: Active

Aesthetic Classification: Digital Industrial / High-Fidelity Wireframe / Dark Terminal

1. Core Philosophy

This system treats the User Interface as a technical schematic. It eschews modern "soft" UI trends (shadows, blurs, gradients) in favor of absolute clarity, rigid grids, and raw data presentation.

The 3 Laws

The Metaphor: An architectural blueprint marked up with a blue engineer's pen.

The Rule of Ink: If it doesn't convey data or structure, remove it.

The Rule of Edge: Containers are sharp (0px radius); controls are organic (999px radius).

2. Color System & Harmony

The palette relies on deep "Cool Slates" to support the Blue accent. Rather than pure blacks, the surfaces utilize low-saturation blue-black tones to create a cohesive, atmospheric temperature that harmonizes with the accent.

2.1 Accent Token (The "Live Wire")

The accent color is treated as a highlighter pen. It indicates active energy, critical data, or primary interactivity.

Token

Hex

Role

color-accent-main

#1563FF

Primary Actions, Active States

color-accent-hover

#4B8AFF

Hover states for primary actions

color-accent-subtle

#0D1526

Very faint accent wash (rarely used)

2.2 Surface Tokens (Deep Cool Slates)

Theory: We use "Slate" tones instead of pure black to reduce visual harshness and harmonize with the violet.

Token

Hex

Role

surface-canvas

#0A0B0D

Global background (Near Black)

surface-card

#121418

Primary container background

surface-subtle

#1A1C22

Internal segmentation

2.3 Ink Tokens (Text & Icons)

Token

Hex

Role

ink-primary

#F0F1F3

Headlines (Off-white for less harshness)

ink-secondary

#A0A4AC

Labels, body text (Cool Grey)

ink-tertiary

#5C6066

Placeholders, disabled states

ink-on-accent

#0A0B0D

Text inside primary buttons

2.4 Border Tokens

Token

Hex

Role

border-grid

#2A2D35

Structural lines (Cool Slate)

border-element

#1E2028

Subtle borders within a card

2.5 Functional Signals (Semantic)

Theory: High-visibility colors selected to maintain temperature consistency or deliberate contrast with the Blue accent.

Token

Hex

Role

Relation to Accent

signal-error

#F87171

Critical Failure

Split-Complementary (High Tension)

signal-warning

#FBBF24

Attention Needed

Complementary (Max Contrast)

signal-success

#34D399

Operational

Analogous Cool (Harmonious)

3. Typography (Modern Minimalist Refinement)

Typography drives the elegance of the system. We use a Neo-Grotesque approach: tighter headlines, wide micro-labels, and a dedicated mono font for data density.

Primary Font: Geist Sans, Inter, or Suisse Int'l. (Rational, clean, neutral).
Data Font: JetBrains Mono or Geist Mono. (Humanist monospace).

3.1 Type Scale & Dynamics

Refinement Note: We avoid heavy weights (Bold/Black). Hierarchy is achieved through size and casing, not thickness.

Role

Weight

Size

Line Height

Tracking

Case

Display XL

Light (300)

48px

1.0 (Tight)

-2.5%

Sentence

H1 Title

Regular (400)

24px

1.2

-1.0%

Sentence

H2 Subhead

Regular (400)

16px

1.4

-0.5%

Sentence

Body Reading

Regular (400)

14px

1.5

0%

Sentence

Label/Micro

Medium (500)

11px

1.0

+6%

UPPERCASE

Data Numerical

Regular (400)

13px

1.4

0%

Tabular Nums

3.2 Typographic Rules

Tabular Figures: All numbers in data tables or dashboards must use font-variant-numeric: tabular-nums to ensure vertical alignment.

Optical Alignment: For Display XL, allow characters to hang slightly into the margin if possible for optical straightness.

No Italics: This system does not use italics. If emphasis is needed, use color (color-accent-main).

4. Grid Architecture (The "Bento" Logic)

The layout uses a visible modular grid.

Gap: 0px. No transparency between cards.

Separation: Cards are separated by 1px solid lines (border-grid).

5. Component Library

5.1 Containers (Cards)

Shape: Strictly Rectangular.

Border Radius: 0px.

Shadows: None.

Stroke: 1px border-grid outline.

Header: Title (Top Left) + Directional Icon (Top Right, in Accent Color).

5.2 Buttons & Controls

Controls serve as the organic contrast to the rigid grid.

Shape: Full Pill (Capsule). border-radius: 999px.

Primary Action: Solid #1563FF background, White text (#FFFFFF).

Secondary Action: Transparent background, 1px #1563FF border, #1563FF text.

Toggles: High contrast. #1563FF circle thumb on a #2A2D35 track.

5.3 Iconography

Style: Linear / Stroke-based.

Stroke Width: 1.5px (Uniform).

Active State: Rendered in Accent Color.

6. Data Visualization

Data should feel like it is drawn with a plotter pen.

Charts: 1px stroke weight.

Active Data Line: Rendered in Accent #1563FF.

Context Lines: Rendered in ink-secondary (#A0A4AC).

Fills: No solid fills. Use vertical hatching or dithering.

7. Imagery & Texture

The "Dither" Mandate: Photographic or 3D content must never be rendered in full gradients. It must be processed to look like 1-bit or grayscale print.

Standard: Grayscale Dither (Light dots on Dark).

Featured/Active: Duotone Dithering (Blue #1563FF dots on Dark).

Perspective: Isometric or Orthographic preferred.

8. Developer Handoff (CSS Variables)

:root {
  /* Surface (Deep Cool Slates) */
  --surface-canvas: #0A0B0D;
  --surface-card:   #121418;
  --surface-subtle: #1A1C22;

  /* Ink (Light on Dark) */
  --ink-primary:   #F0F1F3;
  --ink-secondary: #A0A4AC;
  --ink-tertiary:  #5C6066;
  --ink-on-accent: #FFFFFF;

  /* Accent (Blue) */
  --color-accent-main:   #1563FF;
  --color-accent-hover:  #4B8AFF;
  --color-accent-subtle: #0D1526;

  /* Functional Signals (Brightened for Dark) */
  --signal-error:   #F87171;
  --signal-warning: #FBBF24;
  --signal-success: #34D399;

  /* Borders */
  --border-grid:    #2A2D35;
  --border-element: #1E2028;
  --border-accent:  #1563FF;
  
  /* Typography Stack */
  --font-sans: 'Geist Sans', 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'Geist Mono', 'JetBrains Mono', monospace;
}

/* Utility Class: Grid Cell */
.grid-cell {
  background: var(--surface-card);
  border: 1px solid var(--border-grid);
}


