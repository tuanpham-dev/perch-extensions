---
name: jira-review-qa
description: 'Visual QA of a Jira ticket on a Shopify preview theme: capture the live storefront and the preview at desktop and phone widths, compare them against what the ticket asked for, and report through jira-review. Used by the Jira extension when a ticket is reviewed from Perch.'
---

# Visual QA of a preview theme

This is the Jira extension's QA procedure for **one ticket on a hosted
preview theme**. Your brief (`jira-review brief`) has the facts: the preview
link, the live storefront, the pages, the viewports and the storefront
password. This file is how to use them.

You only look. The folder you are in is the repository for context - read
the code behind something you see if it helps you describe it - but you
change nothing in it, and you never commit or push.

## What QA is for here

Someone will read your report and decide whether the ticket is done without
opening the storefront themselves. So:

- **A claim without a picture is an assertion.** If you could not capture a
  state, say so and report `blocked`. An honest `blocked` beats a `pass`
  nobody can check.
- **Report what is wrong.** A report where everything passes is the least
  useful kind; the defects are what the reader needs.

## 0. Check you can do this at all

You need a browser you can drive and screenshot at a set width - a browser
MCP (Chrome DevTools, Playwright) or a headless browser you can run. Check
before anything else. If you have none, stop and report:

```sh
jira-review qa --status blocked --wrong "No browser tool available to capture the storefront"
```

## 1. Decide what to look at

The brief lists the pages. When it says to decide from the ticket, read the
ticket's own words: the URL it names, the template (a product page, a
collection, the cart drawer), the component. If you cannot tell what would
show the change, that belongs in the report, not a guess dressed as a check.

For each page, also note the **state** the ticket is about: a variant
selected, the drawer open, a product out of stock, a scroll position. A
capture of the wrong state proves nothing.

## 2. Capture the live storefront first

Open the page on the **live** storefront in a **fresh browser context** with
no cookies. Do this before you open the preview: a preview link sets a cookie
that keeps the preview theme on for the rest of the session, and a "before"
taken through it is the preview again.

At each viewport - 1440 wide, then 390 wide - set the width, load the page,
bring it to the state the ticket is about, wait for images and fonts to
finish, and capture. Name files as you save them so they can never be
swapped:

```
live-<page>-1440.png    live-<page>-390.png
```

Full-page captures are fine for layout; for a detail (a gap, a label, an
overlap) take an extra, tighter capture of the component as well.

## 3. Capture the preview

Open the preview link. If a password page appears, enter the storefront
password from the brief. With no password in the brief, report `blocked` and
say the store is password protected.

Confirm the preview theme is actually active - Shopify shows a preview bar,
and the page source names the theme id - before you trust any capture. Then
repeat step 2 exactly: same page, same widths, same state, same scroll.

```
preview-<page>-1440.png    preview-<page>-390.png
```

## 4. Compare

For each page, against the ticket:

- Does the preview do what the ticket asked, at both widths?
- Did anything else change that should not have - spacing, fonts, a section
  missing, a broken image, text overflowing at 390?
- Do interactive states still work: open the drawer, pick a variant, submit
  the form the ticket touches.

Write each defect as one line a developer can act on: where, at which
width, what is wrong. "Price overlaps the Add to cart button at 390 on
/products/pod" rather than "layout issue on mobile".

## 5. Report once

One `--page` per page, each followed by its four captures. Extra captures
use `--shot <file>:<caption>` after the page they belong to, captioned with
what they show.

```sh
jira-review qa --status fail \
  --checked "/products/pod and the cart drawer, 1440 and 390" \
  --wrong "Price overlaps Add to cart at 390 on /products/pod" \
  --note "Checked with the 3-pack variant selected" \
  --page /products/pod \
    --before-1440 live-products-pod-1440.png --after-1440 preview-products-pod-1440.png \
    --before-390 live-products-pod-390.png --after-390 preview-products-pod-390.png \
    --shot preview-drawer-390.png:"Cart drawer open, 390"
```

| Status | When |
| --- | --- |
| `pass` | The ticket's change is there at both widths and nothing else broke. |
| `fail` | Something the ticket asked for is missing or wrong, or something else broke. |
| `partial` | Part of it is right; say which part is not. |
| `blocked` | You could not check: no browser, a password you do not have, a page that will not load. |

If `jira-review` answers with an error - a missing file, an image that is
not a PNG, JPEG or WebP - fix what it names and run it again. The panel shows
nothing until a report is accepted.
