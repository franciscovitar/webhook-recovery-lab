# V3 browser QA — 2026-11-24

Local visual and interaction review of the compiled application against disposable PostgreSQL 17 databases. The browser integration surface failed to initialize, so the run used the environment's local Python Playwright package with system Chromium 156. No external browser service or paid resource was used.

## Viewports and captures

Desktop captures use 1440 × 1000. Mobile captures use 390 × 844, except the narrow navigation review at 320 × 740. The delayed-session captures show the actual startup loader with a 900 ms synthetic request delay. The error capture uses a single synthetic HTTP 503 response from the API. All event and order data is synthetic.

| Screen/state                     | Desktop                                  | Mobile                                    |
| -------------------------------- | ---------------------------------------- | ----------------------------------------- |
| Startup loading                  | [desktop](desktop-00-loading.png)        | [mobile](mobile-00-loading.png)           |
| Overview                         | [desktop](desktop-01-overview-empty.png) | [mobile](mobile-01-overview.png)          |
| Events and filters               | [desktop](desktop-02-events-success.png) | [mobile](mobile-02-events.png)            |
| Event detail                     | [desktop](desktop-03-event-detail.png)   | [mobile](mobile-03-event-detail.png)      |
| Deliveries                       | [desktop](desktop-04-deliveries.png)     | [mobile](mobile-04-deliveries.png)        |
| Endpoints                        | [desktop](desktop-05-endpoints.png)      | [mobile](mobile-05-endpoints.png)         |
| Activity                         | [desktop](desktop-06-activity.png)       | [mobile](mobile-06-activity.png)          |
| Failed delivery / recovery       | [desktop](desktop-07-recovery-dead.png)  | [mobile](mobile-07-recovery-dead.png)     |
| Completed replay detail          | [desktop](desktop-08-replay-detail.png)  | —                                         |
| API error message                | [desktop](desktop-09-error.png)          | —                                         |
| Independent visitor workspace    | [desktop](desktop-10-visitor-two.png)    | —                                         |
| Narrow mobile navigation, 320 px | —                                        | [mobile](mobile-00-narrow-navigation.png) |

## Results

- UI path: create synthetic signed event → inspect persisted detail → resend the same payload and observe dedupe → inspect delivery and activity → create a controlled permanent rejection → enter replay reason → restore receiver and replay → inspect recorded HTTP 422 and 200 attempts.
- Two separate browser contexts received independent cookies and saw only their own workspace data.
- Keyboard review verified the skip link, brand then navigation order, visible focus outline, active navigation `aria-current`, dialog initial focus, focus containment, Escape close and focus restoration.
- All six mobile navigation items remain visible and have at least 44 px height at 390 px and 320 px. Document width matches the viewport at 390 px; no horizontal page overflow was found.
- Loading and API error states rendered the expected message; a failed refresh replaces any stale success with a plain-language error, and success messages auto-dismiss after six seconds. Browser console had no uncaught page errors.
- Visual review found mobile navigation hid the last sections behind horizontal scrolling. The mobile menu now wraps into two visible rows with larger labels and 44 px targets.
