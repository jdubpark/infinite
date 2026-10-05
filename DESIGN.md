---
name: Infinite
description: A quiet working journal for persistent agent sessions.
colors:
  canvas: '#eeeee7'
  paper: '#fafaf6'
  ink: '#222a27'
  muted-ink: '#59645e'
  rule: '#d5d9d1'
  forest: '#23654e'
  white: '#ffffff'
  field-rule: '#bcc6b9'
  placeholder: '#687469'
  focus: '#518d75'
  selected-row: '#dce3d5'
  secondary-surface: '#edf0e7'
  secondary-ink: '#35533c'
  screen-surface: '#eef1e9'
  screen-ink: '#334431'
  running: '#307d54'
  warning-surface: '#f7e8ce'
  warning-ink: '#724314'
  error: '#9d382a'
  terminal-surface: '#202923'
  terminal-ink: '#e4e9de'
typography:
  display:
    fontFamily: Instrument Sans, sans-serif
    fontSize: 43px
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: -0.035em
  headline:
    fontFamily: Instrument Sans, sans-serif
    fontSize: 34px
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: -0.035em
  session-title:
    fontFamily: Instrument Sans, sans-serif
    fontSize: 31px
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: -0.035em
  title:
    fontFamily: Instrument Sans, sans-serif
    fontSize: 18px
    fontWeight: 600
    letterSpacing: -0.02em
  body:
    fontFamily: Instrument Sans, sans-serif
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: Instrument Sans, sans-serif
    fontSize: 13px
    fontWeight: 500
  metadata:
    fontFamily: Instrument Sans, sans-serif
    fontSize: 12px
    fontWeight: 400
  screen:
    fontFamily: ui-monospace, SFMono-Regular, Menlo, monospace
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.7
rounded:
  control: 8px
  native-message: 10px
  panel: 12px
  pairing-sheet: 16px
spacing:
  compact: 8px
  label: 12px
  control-x: 18px
  inset: 20px
  section: 24px
  detail-x: 42px
  spacious: 48px
components:
  button-primary:
    backgroundColor: '{colors.forest}'
    textColor: '{colors.white}'
    rounded: '{rounded.control}'
    padding: 13px 18px
  button-icon:
    backgroundColor: transparent
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    size: 44px
  button-secondary-native:
    backgroundColor: '{colors.secondary-surface}'
    textColor: '{colors.secondary-ink}'
    rounded: '{rounded.control}'
    padding: 13px 18px
  field:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: 13px 14px
  session-row:
    backgroundColor: transparent
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: 16px 14px
  session-row-selected:
    backgroundColor: '{colors.selected-row}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: 16px 14px
  tab:
    backgroundColor: transparent
    textColor: '{colors.muted-ink}'
    padding: 15px 0 16px
  tab-selected:
    backgroundColor: transparent
    textColor: '{colors.forest}'
    padding: 15px 0 16px
  screen-snapshot:
    backgroundColor: '{colors.screen-surface}'
    textColor: '{colors.screen-ink}'
    typography: '{typography.screen}'
    rounded: '{rounded.panel}'
    padding: 22px
  pairing-sheet:
    backgroundColor: '{colors.paper}'
    rounded: '{rounded.pairing-sheet}'
    padding: 48px
  terminal-panel:
    backgroundColor: '{colors.terminal-surface}'
    textColor: '{colors.terminal-ink}'
    rounded: '{rounded.panel}'
    padding: 18px
  composer:
    backgroundColor: '{colors.white}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
    padding: 8px
---

# Design System: Infinite

## Overview

**Creative North Star: "Working journal"**

Infinite presents persistent agent work as a readable record: a warm sheet, dark ink, ruled session rows, and forest-green controls. The visual density leaves room around titles while keeping process state, recorded output, and steering controls close together. The same restrained materials carry pairing, an empty workspace, a busy session list, and a long recording.

This is a code-led description of the local prototype, merged from the earlier design note. The working-journal direction is an implementation assumption, not a user-approved brand or attended visual choice. The reproduced concept-seed evidence is preserved verbatim in `.impeccable/concept-seed.txt` (seed `7872f499`, assigned grounded index `6`). That evidence does not establish an original candidate list, challenger evaluation, or visual approval; none is reconstructed here.

### THESIS

Make returning to a persistent session feel like reopening a working record: identify the session, read what the host last reported, then give the process a direction. State and freshness remain legible alongside the content they qualify.

### OWN-WORLD

Warm paper, restrained green, lightly curved controls, and rules between records define the world. Instrument Sans gives the web client its voice; native system typography adapts it to Android. Monospace identifies terminal content and stable session IDs. Tonal panels provide depth without ornamental shadows.

### STORY

An unpaired device starts with a host connection. A paired device opens the session list. Selecting a session exposes its title, provider, process state, execution location, and the recorded work. Catch up, terminal or recording, and context are views of the same session. The composer stays available below the record when the device has steering access.

### FIRST VIEWPORT

Desktop opens with a session rail beside the overview; a selected session replaces the overview with its detail and composer. The rail includes host type, connection state, and the last successful check time. Narrow web layouts and the native phone show the list first, then a single detail view. Session titles lead; provider and status appear underneath. Native detail also shows the host address and last successful check time.

### FORM

Use a continuous sheet, horizontal rules, compact metadata, and softly rounded controls. The reusable signature is the stable session frame around interchangeable record views. Web view entry uses a brief blur-to-clear transition only when reduced motion is not requested. Native interaction uses immediate pressed feedback and standard phone navigation.

**Key Characteristics:**

- Warm sheet and canvas with ink-led hierarchy.
- Ruled session records with provider, state, and a short stable ID.
- Separate connection freshness, process state, and delivery receipts.
- A persistent composer below interchangeable record views.
- Instrument Sans on web and deliberate native system typography on Android.

## Colors

Forest green sits within a warm neutral palette; state colors identify actual operational conditions. The frontmatter owns the exact values. The sidecar’s generated tonal ramps are preview metadata, not additional implemented palette tokens.

### Primary

- **Forest** (`forest`): primary actions, selected tabs, caret, connection text, and delivery receipts.
- **Running green** (`running`): the small running or connected indicator, paired with a text label.
- **Focus green** (`focus`): web keyboard outlines and the composer focus boundary.

### Neutral

- **Warm canvas** (`canvas`): desktop rail and the ground around the pairing sheet.
- **Paper** (`paper`): the main sheet, form fields, and native safe area.
- **Ink / muted ink** (`ink`, `muted-ink`): titles and controls versus supporting metadata.
- **Rule / field rule** (`rule`, `field-rule`): quiet content divisions versus editable boundaries.
- **Selected row** (`selected-row`): the active web session in the rail.
- **Secondary surface / ink** (`secondary-surface`, `secondary-ink`): native secondary controls and pressed rows.
- **Screen surface / ink** (`screen-surface`, `screen-ink`): readable captured output and shared-context panels.
- **White** (`white`): primary-button text and the web composer interior.
- **Placeholder** (`placeholder`): empty-field prompts on both clients.
- **Terminal surface / ink** (`terminal-surface`, `terminal-ink`): the web terminal replay only.

Warnings use `warning-surface` with `warning-ink`; errors use `error`. Provider initials in the web overview have muted provider-specific fills. Those small identification accents do not define separate product themes.

**The State With Words Rule.** Pair operational color with a readable state label. A green indicator alone cannot establish freshness, successful execution, or task completion.

## Typography

**Display Font:** Instrument Sans, with sans-serif fallback, on web.
**Body Font:** Instrument Sans on web; platform system typography on native.
**Label/Mono Font:** UI monospace, SFMono-Regular, Menlo, monospace on web; Menlo on iOS and monospace on Android for recorded output and IDs.

The web face uses moderate weights and tight title spacing. Native keeps the same hierarchy through the platform font as a deliberate adaptation. The frontmatter describes the web hierarchy; native sizes below are React Native logical font sizes and remain subject to system font scaling.

### Hierarchy

- **Display:** the desktop overview uses `display`; web pairing uses a slightly smaller title (42px, line-height 1.1). Native pairing uses a title (39, line-height 44, weight 500).
- **Headline:** `headline` supplies the web form heading; `session-title` supplies desktop session detail. Narrow detail uses a smaller title (27px). Native list and detail titles use the same role (30, weight 500).
- **Title:** `title` anchors web subsections. Native subsections use an 18-size, weight-500 title; native list rows use a 17-size, weight-500 title.
- **Body:** `body` sets the web base. Native prose uses size 15 with line-height 24. Dense web activity and context text use smaller body text (13px).
- **Label:** `label` describes view and section labels. Supporting metadata uses `metadata`, with denser event and receipt text (11px). Native metadata uses size 11 with line-height 17.
- **Screen:** `screen` preserves terminal formatting. Narrow web snapshots use smaller text (11px); native snapshots use size 11 with line-height 19.

**The Title First Rule.** Put the session title before provider and status metadata. Keep process qualifiers subordinate without hiding them.

**The Record Type Rule.** Use monospace for captured output, code, and stable IDs. Ordinary navigation and prose retain the client’s body face; time labels use tabular figures where the web source specifies them.

## Layout

Desktop uses a two-column grid: a session rail (264px) and a flexible main sheet. At the compact desktop breakpoint (1000px and below), the rail narrows (225px) and detail insets reduce. At the phone breakpoint (700px and below), list and detail become separate full-height views with a back control. Wide detail views increase horizontal insets at 1500px. These exact media queries are recorded in the sidecar.

The main sheet contains a top bar, session heading, view tabs, a scrolling record body, and a composer that does not shrink. The overview has a bounded width (1020px); creation and context content are narrower (760px). There is no separate contextual side panel in the current build: context occupies a tab within session detail.

Native uses safe-area-aware list and detail screens with standard route navigation. Pairing scrolls when space is constrained; a saved connection bypasses pairing on return. Detail has a scrolling record area above the composer. Command keys wrap onto further rows as needed. Native tabs and buttons have a minimum target of 48 logical units; web icon, tab, and command controls have a minimum 44px target. Primary web buttons and fields are taller (46px minimum), and native pairing fields are at least 50 logical units tall.

Native is explicitly fixed light in `apps/mobile/app.json`, including when the OS requests dark appearance. A native dark palette, tablet-specific composition, and native iPhone runtime verification remain future scope, as recorded in `PRODUCT.md`. The dark terminal replay panel is a content surface, not an alternate app theme. The local Android review verified legibility at 1.3 font scale and under OS dark appearance, with the app remaining light and command controls wrapping.

**The Stable Frame Rule.** Keep the selected session and composer in place when switching between its record views. Let the record body scroll independently of the steering controls.

## Elevation & Depth

The current clients use no decorative shadows. Canvas, paper, selected-row fills, pale output panels, and single-pixel rules separate regions. The terminal replay is the deepest tonal surface. Keyboard focus adds an outline to the active control; it does not lift the control or alter the page geometry.

**The Tonal Depth Rule.** Use the existing sheet, inset panel, selection fill, and divider roles to separate content. Preserve their hierarchy before adding a new surface treatment.

## Shapes

Controls and web session rows share the `control` radius. Captured output, context blocks, provider initials, the terminal shell, and the web composer share the `panel` radius. The pairing sheet has a broader `pairing-sheet` radius. The native message field uses `native-message` rounding. Status dots remain small circles with adjacent labels.

Dividers follow the content width. Session records remain rows rather than elevated cards. Fields have a visible one-pixel boundary; selected tabs use a two-pixel underline. Web UI icons are line SVGs. Native controls use visible words such as Sessions, Send, and Interrupt.

## Components

### Buttons

Primary controls are filled forest green with white text and softly curved corners. Web primary buttons use the frontmatter padding and a minimum 46px height; native buttons use the same inset proportions with a minimum 48 logical-unit height. Native secondary controls use a pale surface and darker green text. Web icon and command buttons use a transparent surface.

Web button background transitions last 140ms with ease-out; hover darkens the existing fill slightly. A three-pixel focus outline sits three pixels outside standard web controls. Disabled web buttons reduce opacity to one half. Native pressed or disabled buttons reduce opacity to 0.45; native pressed rows receive the secondary surface. These state treatments are captured in the sidecar snippets.

### Cards / Containers

The pairing sheet is the only broad standalone sheet container. Session lists rely on rows and rules. Screen and context panels use the pale screen surface; terminal replay uses the dark terminal surface. All remain flat. A snapshot wraps long output, preserves whitespace, and scrolls when it reaches its available height.

### Inputs / Fields

Web fields use the paper surface, field rule, control radius, and green caret. Native pairing fields keep the visible outline on the paper screen. Labels remain visible above their fields. Errors appear as text adjacent to the affected form or composer.

The web composer is a white inset within the paper sheet. It receives a shared focus outline so the textarea and send button read as one input area. The native message field has its own rounded outline beside a text-labeled Send or Retry control. An uncertain send retains the input for an explicit retry; controls visually disable when the session cannot be steered.

### Navigation

The desktop session rail identifies each record with title, provider, text state, and an eight-character stable ID. The selected row gains a quiet fill. Native list rows preserve the same information, allow titles to wrap, and use a visible Open label. The overview and list remain useful before a session is selected.

Web detail exposes Catch up, Full terminal, and Context. Native detail exposes Catch up, Recording, and Context. Selected tabs use the primary color and underline; their labels stay in sentence case. The native Recording view is a bounded event list, not an embedded terminal emulator. Back or Sessions returns to the list.

### Session Record and Composer

The session heading starts with the title, then provider and process state. Execution location and process ID remain nearby. Web catch-up pairs the current screen with recent control activity and labels stale snapshots. Native detail includes the host address and successful check time. Connection warnings remain distinct from the process state shown in the record.

A delivery receipt sits immediately above the composer. It describes delivery to the terminal and explicitly leaves agent execution unconfirmed. View-only devices do not receive active steering controls. Context carries its version and source explanation. These labels are part of the visual hierarchy because they determine how confidently the user can act.

## Do's and Don'ts

### Do:

- **Do** keep the warm sheet, ink hierarchy, and forest primary action consistent across pairing, lists, and detail.
- **Do** place session titles before provider and status, and retain short stable IDs in list rows.
- **Do** show connection freshness separately from process status and input delivery.
- **Do** preserve minimum 44px web and 48-unit native control targets, visible focus, and wrapping native command keys.
- **Do** use platform system typography on native while preserving the web hierarchy and Instrument Sans identity.
- **Do** respect reduced motion: web view entry has no blur animation when reduced motion is requested.

### Don't:

- **Don't** imply task completion from a running label, idle screen, connection indicator, or terminal delivery receipt.
- **Don't** remove stale-view warnings while displaying cached session content.
- **Don't** substitute provider-colored page themes for the shared palette.
- **Don't** treat the terminal’s dark surface as a delivered dark app theme.
- **Don't** describe the inferred working-journal direction or seed assignment as user-approved visual identity.
