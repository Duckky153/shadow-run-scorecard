# Shadow Run Scorecard

**All data here is synthetic.** Every shipper, facility, reference number and load is made up.

## What it does

A fictional mid-size freight broker is two weeks into a shadow run of an AI order-entry agent. Shipper tenders arrive as a PDF, an email body or a spreadsheet. The agent extracts each load, and reps still key the same load into the TMS by hand.

The main page (`index.html`) answers one question: **which shippers are ready to stop human review, and what is blocking the rest?** It shows one live result sentence, a threshold selector and a commodity toggle, a shipper table with status and reason, a drill-down of mismatched fields for each shipper, a "Needs a person" list, the rules, the assumptions and the open questions.

The second page (`feedback.html`, "Feedback for Product") turns the same mismatches into structured feedback: one row per pattern with loads affected, shippers, example loads (linking back to the drill-down), who fixes it, whether it blocks go-live and a one-line next step. A "Copy as text" button produces a plain-text summary to paste into a team channel.

## How it works, in plain English

For two weeks the agent and the reps handle the same tenders, and every load is compared field by field. The rep's record is the answer key, except where the tender itself shows the rep was wrong.

The rules, one sentence each:

1. A field matches when both values are equal after trimming spaces, ignoring case and writing dates and times one way; units are not converted, so a weight in kilograms fails.
2. Eight fields are critical (reference, pickup facility, delivery facility, pickup date, pickup appointment, delivery appointment, weight and stops), which makes 8 per load and 96 per shipper; commodity text counts only when the toggle is on.
3. A field the tender shows the rep got wrong is disputed, left out of the rate and listed under "Needs a person".
4. A shipper's match rate is its matched critical fields divided by its compared critical fields.
5. "Ready to skip review" means the rate is at or above the bar, at least 10 loads were seen and no mismatch type appears twice.
6. "Needs a config rule" means the mismatches that repeat are all types that can be fixed in setup.
7. "Keep in review" covers everything else, and the reason column says why.

Why a repeated mistake blocks go-live even above the bar: a repeat is a pattern, and a pattern will keep happening once review is switched off.

How each mismatch type is spotted:

| Type | How it is spotted | Fixable in setup |
|---|---|---|
| Time zone | Same appointment shifted by whole hours, so one side was not converted to Central | Yes |
| Facility alias | Two different facilities with the same name prefix (a nickname like "DC 4" mapped to the wrong one) | Yes |
| Units (kg not converted) | The agent's weight times 2.20462 is within 1% of the rep's | Yes |
| Commodity wording | Commodity text worded differently (only when the toggle is on) | Yes |
| PO only in subject line | Reference left blank and the PO number appears only in the email subject line | No |
| Missing reference | Reference left blank and the rep has one | No |
| Stop order | Same stops in a different order | No |
| Window cut short | The rep has a window and the agent kept only its start time | No |
| Wrong value | Any other difference | No |

On the feedback page there is one row per mismatch type, plus a "Disputed rep record" row for the fields where the tender shows the rep was wrong. A pattern blocks go-live for a shipper that is not ready when the pattern repeats there or the shipper is under the bar. Disputed records never block, because they are left out of the rate. "Who fixes it" is a fixed choice per type: setup problems go to deployment config, extraction gaps go to Product and Engineering, and a wrong rep record goes back to the customer's data.

All rate math uses integer counts. Percentages are rounded down to one decimal, so a rate that fails the bar never displays as if it passed.

## What the data shows

- At 98% (the default): Shippers A, C and E can skip review; Shipper D needs time-zone and facility rules; Shipper F needs a kg-to-lb rule; Shipper B stays in review (94 of 96, 97.9%, and the same mismatch twice).
- At 99%: a shipper with 95 or 96 compared fields can't have a single mismatch, so C (one cut-short appointment window) and E (one swapped stop order) drop to Keep in review.
- At 95%: B clears the rate but still stays in review, because its missing PO repeats and can't be fixed in setup.
- With commodity text counted: Shipper E falls out of ready over wording like "Paper towels" versus "PAPER TWL", which wouldn't break a load. That is why it is off by default.
- Counting commodity also adds 12 easy fields per shipper, which can lift a rate: at 99%, Shipper C passes with commodity counted (106 of 107) but not without it (94 of 95). Extra fields that rarely break a load make the bar easier to clear, which is another reason commodity stays off by default.

Seeded patterns: Shipper D has 5 pickup appointments in local time while the TMS uses Central, and 2 deliveries where "DC 4" was mapped to a similar facility name. Shipper F has 4 spreadsheet rows in kilograms. Shipper B has 2 emails where the PO is only in the subject line. Shipper E has 1 multi-stop load with stops 2 and 3 swapped. Shipper C has 1 window of 08:00-14:00 cut to 08:00. Shipper A is clean. Shippers A and C each have 1 pickup date where the rep's entry contradicts the tender and the agent matches it.

## Assumptions

- The rep's record is the answer key, except for disputed fields.
- Each load has 10 fields: reference/PO, pickup facility, pickup date, pickup appointment, delivery facility, delivery appointment, equipment, weight, stops and commodity. Equipment is recorded but not scored.
- The TMS keeps times in Central.
- The bar is the share of critical fields the agent must get right before a shipper's orders stop going through human review.
- A shipper needs at least 10 loads in the shadow run before it can be judged ready.

## How to run

- Open `index.html` in any modern browser. Double-clicking the file works; there is no build step, no server, no library and no network call.
- Run the tests with Node 18 or newer, no installs: `node tests/run-tests.mjs`

`scorecard.mjs` holds every rule. It has no imports or exports, so the page can load it as a plain script from disk, and the tests load it with Node. `data.js` holds the synthetic data. `app.js` and `feedback.js` only draw the two pages.

The scorecard passes its settings to the feedback page through the link (for example `feedback.html?t=99&c=1`). On the feedback page, each example load links back to that shipper's drill-down and highlights the load; a disputed load highlights its card under "Needs a person" instead, because its fields are left out of the drill-down. Nothing is saved.

## Limits

- The data is synthetic and the error patterns were seeded on purpose. The numbers show how the scoring works, not how any real agent performs.
- Mismatch types come from simple checks. A real shadow run would turn up types this page doesn't know, and those land in "Wrong value".
- Disputes are flagged in the data rather than detected; in practice a person would flag them when the tender and the rep disagree.
- Go-live is decided per shipper with one bar for every field. It doesn't support a stricter bar for appointment times or a per-field go-live.
- "Needs a config rule" says what to fix first, not that the shipper will be ready afterwards; it would be rescored on new loads.
- "Who fixes it" and the next steps are fixed per type, not learned from history.
