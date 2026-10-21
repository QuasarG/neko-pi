---
name: neko-pi terminal frontend
description: A theme-preserving conversation workspace with factual resident status.
---

# Design System: neko-pi

## Overview

The frontend extends the incumbent OpenTUI/Solid terminal interface. Conversation and
project context remain primary; Neko's identity, memory availability, and reserved blank
portrait area occupy the sidebar. This is an extension of the existing visual system, not a new
palette or layout system.

The active user theme is the visual authority. Native components, terminal typography,
focus behavior, and keymap commands remain in use. No browser or HTML/CSS styling model
is implied by this document.

## Colors

Use semantic references from `useTheme()` rather than fixed color values:

- `theme.background.base`: main surface, empty wordmark pixels, and lower-shadow blend background.
- `theme.background.raised.base`: home identity sidebar surface.
- `theme.text.base`: resident identity text and the `pi` lettering.
- `theme.text.muted`: `neko-` lettering, availability metadata, and explanatory text.
- `theme.text.action.primary.selected`: wordmark shimmer and presence hover state.

**The Theme Ownership Rule.** Ordinary surfaces inherit the active theme. Do not create a
second hardcoded palette for resident components. Theme-dependent values are intentionally
not duplicated as fixed frontmatter color tokens.

## Typography

Text uses the terminal's monospace rendering. The resident wordmark uses custom lowercase
lettering packed into half-cell blocks, occupying 32 columns by four rows. Shared x-height,
square counters, an ascending k, and a descending p define the glyphs. A one-pixel lower
shadow blends the letter color into the existing background at 25% strength.
Never enlarge it with terminal width. Compact layouts use the plain text `neko-pi`.

## Layout

The home composer remains centered in the main area, with a maximum width of 75 columns.
At terminal widths of at least 110 columns, the home adds a 38-column sidebar with two
cells of padding. Below that width, `/neko` keeps status accessible without a sidebar.
Session presence lives in the existing sidebar footer alongside project context.

The wordmark chooses its form from its available width: below 46 columns, or below
20 terminal rows, use plain text; otherwise use the half-cell bitmap. Home reserves sidebar space before choosing
the wordmark width. These are terminal cell thresholds, not CSS breakpoints.

Presence is hidden below 18 terminal rows. From 32 rows, reserve a blank portrait
area of 28 columns by 12 rows. The owner rejected block-rendered portraits; leave this
area empty until a replacement is approved. Existing session sidebar visibility remains in charge.

## Elevation & Depth

Native tonal surfaces establish depth. The home sidebar uses the raised background token;
resident status adds no shadow or decorative card frame. Details use the existing dialog
layout and header.

## Shapes

Preserve native terminal boxes and existing composer/dialog borders. The wordmark uses
cell-aligned blocks. The portrait area is intentionally empty.

## Components

### Wordmark

`Logo` renders the lowercase `neko-pi` lettering. Pointer position controls a local shimmer;
the 70 ms animation timer exists only during hover and is cleaned up on exit. Disabling
animations yields a static action-color highlight. Resting state has no idle animation.

### Resident presence and details

`NekoPresence` shows the installed display name, identity-pack availability, and a count
of the two expected memory files. Clicking opens `NekoDetails`; the global `/neko` command
provides keyboard access. Details distinguish file availability from successful reads and
configured checks from enforcement. Private memory text is never rendered.

Portrait rendering is currently disabled at the owner's request. Keep the reserved space blank
and textual status usable. Do not copy private images or persona
content into the source tree or documentation.

### Persona file bindings

The existing right sidebar includes a compact, scrollable file list below resident status.
Rows show a binding kind, file name and truncated path; hover uses the theme action color.
The list includes only files under `~/.neko_pi` that the runtime uses: persona identity and
voice, the persona manifest, active memory records, and continuity state. It does not scan
persona prose for path mentions or list workspace instructions. Clicking an available row
uses the system default application. `/persona-files` provides a searchable keyboard
equivalent at all terminal sizes, including the full path. Refresh metadata every two seconds
and retain the last successful list on connection failure. Do not show document bodies.

### Composer and session context

Reuse the existing prompt, model selection, dialog, project-path actions, and sidebar
structure. Preserve the main chat layout. Remove inherited advertising and incorrect support
branding while retaining third-party licenses and internal protocol identifiers.

## Do's and Don'ts

- **Do** preserve active theme tokens, keyboard commands, and mouse/animation preferences.
- **Do** verify native captures at wide and compact terminal sizes.
- **Do** describe status as availability, with limitations visible in `/neko`.
- **Don't** claim that available memory files were read in the current turn.
- **Don't** claim configured persona checks are already enforced.
- **Don't** treat restart-persistent bridge history as completed by this visual extension.
- **Don't** move identity or the private portrait into the main conversation area.
