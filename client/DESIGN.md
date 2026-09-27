---
name: Clinical High-Reliability Dispatch
colors:
  surface: '#f9f9ff'
  surface-dim: '#c8dbfe'
  surface-bright: '#f9f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f0f3ff'
  surface-container: '#e7eeff'
  surface-container-high: '#dee8ff'
  surface-container-highest: '#d6e3ff'
  on-surface: '#071c36'
  on-surface-variant: '#3d4948'
  inverse-surface: '#1f314d'
  inverse-on-surface: '#ecf1ff'
  outline: '#6d7978'
  outline-variant: '#bcc9c8'
  surface-tint: '#006a67'
  primary: '#006765'
  on-primary: '#ffffff'
  primary-container: '#008280'
  on-primary-container: '#f3fffd'
  inverse-primary: '#6fd7d3'
  secondary: '#006a67'
  on-secondary: '#ffffff'
  secondary-container: '#6ef4ef'
  on-secondary-container: '#006e6c'
  tertiary: '#b51735'
  on-tertiary: '#ffffff'
  tertiary-container: '#d8354b'
  on-tertiary-container: '#fffbff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#8cf4ef'
  primary-fixed-dim: '#6fd7d3'
  on-primary-fixed: '#00201f'
  on-primary-fixed-variant: '#00504e'
  secondary-fixed: '#71f7f2'
  secondary-fixed-dim: '#4fdad6'
  on-secondary-fixed: '#00201f'
  on-secondary-fixed-variant: '#00504e'
  tertiary-fixed: '#ffdada'
  tertiary-fixed-dim: '#ffb3b4'
  on-tertiary-fixed: '#40000b'
  on-tertiary-fixed-variant: '#920025'
  background: '#f9f9ff'
  on-background: '#071c36'
  surface-variant: '#d6e3ff'
typography:
  display-lg:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 30px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 26px
    letterSpacing: -0.01em
  headline-sm:
    fontFamily: Space Grotesk
    fontSize: 16px
    fontWeight: '600'
    lineHeight: 22px
    letterSpacing: -0.005em
  body-lg:
    fontFamily: Public Sans
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Public Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  body-sm:
    fontFamily: Public Sans
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
  label-lg:
    fontFamily: Public Sans
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 18px
  label-md:
    fontFamily: Public Sans
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.02em
  telemetry-lg:
    fontFamily: JetBrains Mono
    fontSize: 20px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.02em
  telemetry-md:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 18px
    letterSpacing: -0.01em
  telemetry-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '500'
    lineHeight: 14px
    letterSpacing: 0.01em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-dense: 0.5rem
  margin: 1.5rem
  margin-dense: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
  space-2xl: 2rem
---

## Brand & Style

The design system is constructed specifically for mission-critical medical dispatch, emergency response coordination, and healthcare logistics. The primary target audience consists of emergency medical dispatchers, triage supervisors, and hospital operations directors who operate under extreme temporal pressure, cognitive fatigue, and zero-margin-for-error conditions. 

The aesthetic is functional, calm, and clinically decisive—a direct rejection of consumer SaaS ornamentation, ambient decorative gradients, and ambiguous computational metrics. Drawing from high-contrast clinical minimalism and mission-critical avionics/telemetry systems, the visual architecture prioritizes:
- Instantaneous visual scanability and low cognitive overhead.
- Absolute differentiation of priority states (routine vs. urgent vs. critical emergency).
- Precise density that balances complete data visibility with uncompromised legibility.
- Deep ergonomic trust through predictable spatial placement, rigid alignment, and unambiguous affordances.

## Colors

The system uses a calibrated, high-contrast light mode engineered for multi-monitor command center environments. The palette deliberately separates operational controls from status indicators:

- **Canvas & Structural Surfaces**: The base canvas is `#F3F7FA` (Ice Gray), providing a low-glare backdrop. Elevated containers, tables, and functional cards utilize `#FFFFFF` (Pure White). Structural definition is strictly maintained via `#D9E2EA` (Soft Blue Gray) borders.
- **Typography & Neutrals**: Primary information, active labels, and critical metrics are rendered in `#0B1F3A` (Midnight Navy), ensuring an ultra-sharp contrast ratio (>10:1 against white). Secondary telemetry, metadata, and passive units use `#64748B` (Slate Gray).
- **Operational Primaries**: `#0F8F8C` (Deep Teal) drives primary actions, confirmations, and persistent system states. `#18B9B5` (Bright Teal) is reserved for interactive accents, hover highlights, active focus indicators, and route-path tracking.
- **Critical Diagnostics & Status**:
  - **Emergency / Urgent**: `#F54B5E` (Emergency Coral) is exclusively reserved for Level-1 emergencies, triage alerts, timeouts, and negative exceptions. It must never appear decoratively.
  - **Success / Active En Route**: `#36B37E` (Success Green) indicates successful vehicle dispatch, patient handoff completion, stable vitals, and normal operational thresholds.
  - **Muted Warning (Functional)**: `#D97706` (Amber 600) is used sparingly for staging delays and non-critical reroutes.

## Typography

Typography enforces a strict hierarchy:
- **Display & Headings (Space Grotesk)**: Chosen for structural precision and geometric clarity. Used for high-level screen anchors, module titles, and critical unit identifiers.
- **Body & Controls (Public Sans)**: Engineered for institutional legibility and neutral presentation. Used across instructions, patient manifests, dispatcher logs, notes, and general UI actions.
- **Telemetry & Timestamping (JetBrains Mono)**: Monospaced numbers are mandatory for live countdown timers, vehicle telemetry (ETA, speed, bearing), coordinate readouts, and ticket IDs. This prevents layout jitter during continuous real-time data streaming.

## Layout & Spacing

The layout is built for multi-monitor desktop workstations (1920x1080 and 2560x1440 standard dispatch consoles):
- **Grid Architecture**: 24-column flexible desktop grid allowing granular division between the incident map (typically 14–16 columns), unit queue/telemetry (5–6 columns), and incoming call/triage stack (4–5 columns).
- **Rhythm & Padding**: A baseline 4px/8px modular scale. Spacing is intentionally tight (`space-xs` through `space-md` within data rows) to maximize visible situational awareness above the fold without requiring vertical scrolling during active dispatches.
- **Responsive Handling**:
  - **Desktop (>=1440px)**: Three-pane persistent view: Incident Stream, Live Geo-Tracking/Routing, Dispatch Console.
  - **Compact Desktop / Tablet Landscape (1024px - 1439px)**: Map collapses to a split tab or background toggle; unit queue takes precedence.
  - **Mobile (<1024px)**: Read-only escalation mode. Single-column stacked cards with bottom-anchored tactical action sheet.

## Elevation & Depth

This system avoids heavy drop shadows and faux blur effects, which induce visual fatigue and degrade contrast across standard medical displays. Instead, it relies on **low-contrast structural outlines and planar surface tiers**:

- **Ground Plane (`#F3F7FA`)**: The application viewport canvas.
- **Tier 1 - Structural Modules (`#FFFFFF` with 1px border `#D9E2EA`)**: Map container, data tables, dispatch sidebars, incident inspection trays.
- **Tier 2 - Hover / Active Selection**: Surface remains `#FFFFFF`, but the border shifts to `#18B9B5` (or `#0F8F8C`), paired with a crisp 1px keyline offset.
- **Tier 3 - Floating Overlays & Context Menus**: Background `#FFFFFF`, 1px solid `#D9E2EA`, augmented by an ultra-subtle ambient drop shadow: `0 4px 16px -4px rgba(11, 31, 58, 0.08)`.
- **Emergency Priority Elevation**: When an incident escalated to critical priority is focused, elevation is conveyed through an outer stroke `2px solid #F54B5E` rather than a colored drop shadow.

## Shapes

The interface embraces a structured, engineered aesthetic using **Soft (`roundedness: 1`)** geometry:
- Default components (buttons, input fields, cards, table cells): `0.25rem` (4px).
- Modals, flyout panels, and alert banners: `0.5rem` (8px).
- Badges, status chips, and numerical telemetry tags: `0.25rem` (4px) or strict pill radius `9999px` solely for single-letter/status-dot indicators.

Sharp, slight corner radiuses maintain crisp alignments with tabular dispatch data and geographical viewports.

## Components

### Buttons & Operational Triggers
- **Primary Operational Action (e.g., "Confirm Dispatch", "Reroute Unit")**: Solid `#0F8F8C`, label `#FFFFFF`, 0.25rem border-radius. Hover: `#0D7A77`. Active: `#0A6260`.
- **Critical / Emergency Action (e.g., "Signal Code Red", "Abort Mission")**: Solid `#F54B5E`, label `#FFFFFF`. Hover: `#E0364A`.
- **Secondary Utility Action**: Surface `#FFFFFF`, border `1px solid #D9E2EA`, label `#0B1F3A`. Hover: background `#F3F7FA`, border `#64748B`.
- **Key Command Indicators**: Buttons must display keyboard shortcut brackets (e.g., `[D]`, `[Enter]`) using JetBrains Mono inside secondary text tags.

### Status Badges & Priority Chips
- Compact height (20px–24px), font `label-md` or `telemetry-sm`.
- **Level 1 (Critical Emergency)**: Background `#FEF2F2`, border `1px solid #F87171`, text `#991B1B`, with a persistent pulsating `#F54B5E` status dot.
- **En Route / Active**: Background `#ECFDF5`, border `1px solid #6EE7B7`, text `#065F46`.
- **Standby / Staged**: Background `#F1F5F9`, border `1px solid #CBD5E1`, text `#475569`.

### Telemetry Cards & Incident Modules
- Surface `#FFFFFF`, border `1px solid #D9E2EA`.
- Header: Divided by a 1px border `#D9E2EA`, displaying Incident ID in `JetBrains Mono` and elapsed time counter with monotonic numeric tabular alignment.
- Padding: strictly `space-md` (12px) to keep metrics tightly packed without clutter.

### Tables & Real-Time Incident Feeds
- Header row: `#F3F7FA` surface, text `#64748B` in uppercase `label-md`, 1px bottom border `#D9E2EA`.
- Data rows: height 44px, alternating white / muted zebra striping (`#FAFBFD`), hover state `#EEF4F8`.
- Dynamic sorting, zero visual divider lines between columns—spacing governed strictly by `gutter-dense`.

### Form Controls & Filter Inputs
- Inputs: Surface `#FFFFFF`, border `1px solid #D9E2EA`, text `#0B1F3A`, placeholder `#64748B`.
- Focus state: Border `1.5px solid #18B9B5`, outline `none`.
- Quick-filter search bars integrate leading monospaced search command keys (`/`).

### Dispatch Map Markers & HUD Overlays
- Floating Map HUD: Surface `#FFFFFF` with `1px solid #D9E2EA` housing unit filters, traffic layers, and hospital bed capacity counters.
- Ambulances/Units: Crisp directional chevron markers filled with `#0F8F8C` (idle/en route) or `#F54B5E` (responding code red), accompanied by high-contrast monospaced ETA callouts.