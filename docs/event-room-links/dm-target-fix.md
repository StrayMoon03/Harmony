# DM delivery versus linked room: production correction

The owner's screenshot showed private admin notices, not messages posted in Cinema. Production logs confirmed the first Send action stopped because its linked room was missing, followed by a room-selection action that failed with Missing Access before any job was queued.

The previous lookup forcibly fetched the individual channel. The corrected lookup obtains fresh room metadata from the guild channel inventory and uses the cached guild when available. It does not require posting in the target room, reading its messages or changing its permissions. Recipient View Channel / voice Connect checks are still performed. Missing, foreign-server, unsupported or incomplete room metadata is rejected.

A linked native event may supply its channel. Explicit same-server channel mentions/URLs or an unambiguous #channel name in the location can identify the button target; general locations and announcement channels are never guessed. Otherwise staff chooses the room in the native channel selector.

The private controls now explicitly show Delivery: Private DMs and Button opens: #room. Entry points say Send Room Links by DM, with Send DM Now and Room the DM button opens controls. Errors and receipts are labeled Private DM, so choosing the link target cannot be mistaken for selecting a public posting destination. The only sending call in the delivery path remains dm.send.

Validation: 1,038 full regression tests, 183 focused scheduling tests and 33 final room-link tests passed, zero failed/skipped. The added real Discord.js test denies bot View Channel/Send Messages and the individual-channel REST lookup, allows the recipient's room access, and verifies that guild metadata lookup leads to exactly one DM with the correct link. No channel post or permission mutation is permitted by that test. Additional tests cover explicit references, rejecting unsafe metadata, retaining recipient access restrictions and clear UI wording. Syntax and whitespace checks passed.

Existing members, schedules, room preferences, jobs, personal reminders and event data are preserved. There are no schema/dependency changes. No additional real test messages were sent. Successful delivery to the owner's particular recipient still needs confirmation after the owner uses the corrected controls.
