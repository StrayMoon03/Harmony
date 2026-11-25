# Room-message silent feedback and first-DM fix

Follow-up to merged PR #331, after the owner reported no message and no visible result.

- Opening the private picker acknowledges the interaction before building its content.
- Send Now immediately shows Sending, followed by explicit Delivered / Not delivered / Waiting counts and per-member failure reasons.
- A separate private receipt makes the result visible independently of a long or collapsed setup message. Receipt errors cannot change a successfully delivered job into a falsely failed delivery.
- Delivery/action failures are logged without message bodies or credentials. Startup emits read-only aggregate queue counts and sanitized existing failure records, so older failed attempts can be diagnosed without another test send.
- A new DM no longer requires permission to read an empty conversation before the first send. Only known history-access denials use a persisted conservative snowflake time boundary. Rate limits and network errors retain backoff. An unknown send outcome still requires successful history recovery before any resend; inaccessible history never authorizes a duplicate.
- Existing recipients, jobs, permissions, RSVP, personal reminders and event settings are preserved. No schema or dependency changes.

Validation: 1,034 full regression tests and 179 focused scheduling tests passed, with zero failures/skips. The final room-link target check passed all 29 tests. Syntax and whitespace checks passed. Tests include immediate progress, separate private success/failure receipts, denied first-DM history access, and fail-closed unknown-outcome recovery.

These are confirmed code-path corrections. They do not establish the cause of this particular live attempt until the saved production status is inspected. No real test message was sent during implementation.
