# V3 — Spanish presentation and usability refinement

Owner feedback, 2026-11-24: preserve the functional application; make it intuitive, professional and Spanish-first. Baseline `c86c4f620ae22e39ecb62c311e707a8a0a8ba9f0`. PAS main `2cb6f3ac30142f9bdf38717aa6818823761ea2ce`.

## Sources and decisions

- L01–L06 actual catalog `AI/projects/genova-delivery-os/LIBRARY_CATALOG_V2.md` (blob `91957d8829706df179b62fb41aacc6ef68402984`).
- Research foundation `FOUNDATION_TEN_FAMILIES_RESEARCH_20261016.json` (blob `f3c6de165677653c0a5f70eb7da3a5c925f176f7`).
- `WEB_ART_DIRECTION_ENGINE_V2.md` (blob `2b659d13d86c1f2bc7d8ab1a6591c38dd62dfc38`) and `WEB_ART_DIRECTIONS_V2.json` (blob `f296503a2f1080383bc8cda926ec3b806289bc2a`).
- L01: product clarity / operational dashboard rather than editorial landing or full visual rebrand. L02: retain existing navy/teal with readable semantic tokens. L03: Spanish navigation and task-first flow, visible scenario control, meaningful empty states and progressive disclosure of technical records. L04: responsive rem-based text, readable tables and spacing, no external fonts/assets. L05: use the owner's screenshot feedback as qualitative evidence; no user study or measured conversion claim. L06: focusable native controls, larger targets, reduced-motion and mobile reflow. These sources are design/research guidance, not tested component certification.

## Scope

Presentation layer only: existing APIs, database schema, worker, receiver, infrastructure and static showcase unchanged. IDs and JSON are retained; technical details are available on demand. New event and recovery actions use the existing API. The Events CTA navigates to the form instead of immediately sending an event. Existing browser focus management is retained and extended for the technical disclosure.

## Acceptance still required

Run repository-wide format, lint, typecheck, build and affected tests in Node 24. Repeat real browser QA at 1440, 1024, 390 and 320 px, plus 200% zoom; verify Spanish text, no clipped labels, keyboard and modal focus, delivery, duplicate feedback, failure/recovery and preservation of raw IDs/JSON. Confirm no unintended English UI strings except brand/protocol/raw records. Review contrast and screenshots. Do not claim WCAG conformance or browser pass from source changes alone. Do not deploy until QA and owner approval. No additional dependencies or providers; US$0 additional target.

This is a source checkpoint, not deployed code. Previous QA applies to the prior application commit only.
