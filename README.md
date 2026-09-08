# stqry-dashboard

A Google Analytics 4 dashboard showing total visitors (weekly, monthly, yearly)
and the most visited pages.

- **Headline totals** — visitors for the last 7 days, 30 days and 12 months,
  each with the change against the equivalent preceding period.
- **Visitors over time** — a trend for the selected range, drawn against the
  comparison period, with a crosshair readout and a table view.
- **Most visited pages** — the top pages by views, with visitors and average
  engagement time per page.

It runs on generated sample data until you give it credentials, so you can see
the whole thing working before touching the Google Cloud console.

## Quick start

```bash
npm install
npm start          # http://localhost:3000
```

With no `.env` present this starts in sample-data mode and shows a banner
saying so. Nothing on screen is passed off as real analytics.

## Connecting your GA4 property

You need two things: the property ID, and a service account allowed to read it.

**1. Find the property ID.** In Google Analytics: Admin → Property details. It
is a number like `123456789`. This is not the `G-XXXXXXX` measurement ID.

**2. Create a service account.** In the [Google Cloud console](https://console.cloud.google.com):

- Enable the **Google Analytics Data API** for your project
  (APIs & Services → Library → "Google Analytics Data API" → Enable).
- IAM & Admin → Service Accounts → Create service account. No project roles are
  needed — the permission that matters is granted inside Analytics, not here.
- On the new account: Keys → Add key → Create new key → JSON. Keep the download
  safe; it is a credential.

**3. Grant it access to the property.** Back in Google Analytics: Admin →
Property access management → `+` → add the service account's `client_email`
with the **Viewer** role. Without this step the API returns 403 no matter how
correct the key is.

**4. Configure the app.**

```bash
cp .env.example .env
```

Fill in `GA_PROPERTY_ID` and one of the three credential options, then set
`GA_TIMEZONE` to your property's reporting timezone. Restart, and the sample
data banner disappears.

`GET /api/health` reports whether it is running on live or sample data.

## Hosting it

The dashboard is a Node server plus static files, so it needs a host that runs
Node — Render, Railway, Fly.io, Google Cloud Run, or any VPS. It **cannot** go
on static hosting like GitHub Pages, Netlify's static tier, or an S3 bucket.

That split is deliberate. The service-account key is allowed to read your
entire Analytics property, so it has to stay on the server. If the browser
called the GA API directly, the key would be sitting in the page source for any
visitor to lift. The frontend only ever talks to this app's own `/api/*`
endpoints.

For any of those hosts the build is:

- **Build command:** `npm install`
- **Start command:** `npm start`
- **Environment variables:** the ones from `.env.example`. Use
  `GA_CREDENTIALS_JSON` (the whole key file on one line) where you can only set
  variables rather than upload files — that covers Render, Railway and Fly.
- The app listens on `process.env.PORT`, which these hosts set for you.

On Google Cloud Run there is a neater option: deploy under a service account
that you granted GA Viewer access, set only `GA_PROPERTY_ID`, and leave the
credential variables empty. The Google library picks up the ambient identity,
so no key file exists to leak.

**Anyone who can reach the URL can read your analytics.** There is no login. If
you deploy it anywhere public, put access control in front of it — your host's
password protection, an identity proxy such as Cloud Run's IAM or Cloudflare
Access, or a reverse proxy with basic auth.

## Refreshing and caching

Results are cached on the server for 30 minutes (`CACHE_TTL_MINUTES`), and an
open page pulls again once its copy expires.

Both halves are demand-driven — nothing runs on a timer with no audience:

- **The cache fills only on request.** There is no background job keeping data
  warm. A dashboard nobody has open makes zero API calls.
- **A hidden tab asks for nothing.** When the refresh falls due in a
  backgrounded tab it is skipped, not queued; the page catches up the moment
  someone brings it back to the front.
- **Simultaneous viewers cost one query.** Concurrent requests for the same
  stale data share a single in-flight GA call rather than each firing their own.
- **Failures are not cached.** A GA error is never held for the rest of the
  TTL — the next request retries, and an open page retries on its own after
  five minutes.

Note this is one query per *distinct report*, not one in total: a page asks
five different questions, so a cold load costs five queries and a busy day
costs 48 of each. `npm test` pins all of this down.

The practical effect on quota: a first visit costs five GA queries, and every
visit for the next half hour costs none, however many people load the page.

The footer shows when the data was actually fetched from Google, which is not
the same as when the page was served. Set `CACHE_TTL_MINUTES=0` to bypass the
cache entirely while developing.

## Tests

```bash
npm test
```

No test dependencies — it runs on Node's built-in test runner.

The suite's main job is pinning down the quota guarantee. `test/quota.test.js`
injects a fake GA backend that counts every query reaching it, so each
assertion is counting calls that would really have spent quota:

- A cold page load makes exactly five queries, and the monthly totals shared
  between the two endpoints are fetched once, not twice.
- 100 sequential loads, and 50 simultaneous cold ones, still make only those
  five.
- Over a simulated 24 hours with someone loading the page every minute, each
  report is fetched exactly 48 times — once per half-hour window. 1,440 page
  loads cost 240 queries instead of 7,200.
- A report is refetched a millisecond after its window lapses, and not one
  before.
- A day passing with nobody opening the page makes zero queries.
- A GA failure is retried rather than cached for the rest of the window.

`test/cache.test.js` covers the cache's own contract underneath that.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/headline` | Visitor totals for all three periods, with deltas |
| `GET /api/overview?range=weekly\|monthly\|yearly` | Summary, trend and top pages for one range |
| `GET /api/health` | Whether live GA or sample data is in use, plus cache stats |

Responses carry `meta.generatedAt` (when the data was fetched from GA) and
`meta.nextRefreshAt` (when its cached copy goes stale, or `null` if caching is
off). They are sent `Cache-Control: no-store`, so the server-side cache is the
only cache — browsers and proxies never keep their own uncoordinated copies.

## How the numbers are defined

- **Visitors** is GA4's `totalUsers`. Page-level figures use `screenPageViews`
  and `userEngagementDuration`.
- **Weekly** is the last 7 days, **monthly** the last 30, **yearly** the last 12
  calendar months. These are rolling windows, not calendar weeks or months.
- **Comparisons** use a window of the same length immediately before the
  current one, except for yearly, which compares against the same window one
  year earlier so a partial month is never measured against a complete one.
- **The last bucket is always in progress** — today, or the current month — so
  it reads lower than a finished one. The chart footnote says so, and the
  tooltip marks the point.
- **Day boundaries** come from `GA_TIMEZONE`. If it disagrees with your
  property's reporting timezone, daily totals will be cut at the wrong hour.

## Layout

```
server/
  index.js     Entry point: builds the app and listens
  app.js       Express routes and the JSON API
  cache.js     Demand-driven TTL cache with in-flight de-duplication
  config.js    Environment parsing, credentials, live-vs-sample decision
  ga.js        GA4 Data API queries
  mock.js      Deterministic sample data
  ranges.js    Date-window maths for the three ranges
public/
  index.html   Page structure
  styles.css   Design tokens, light and dark
  app.js       Charts (hand-drawn SVG), tables, interaction
test/
  quota.test.js  How many queries reach GA, and how often
  cache.test.js  The cache's contract
  helpers.js     Counting GA stand-in, and a server with a hand-driven clock
```

## Notes

- `createApp()` takes an optional data source and cache, which is how the tests
  count real GA queries and drive the clock by hand. Production passes neither.
- The charts are plain SVG with no charting library, so the whole frontend
  depends on nothing beyond the browser.
- Colours are validated for colour-vision deficiency and for contrast against
  both the light and dark surfaces. Every chart also has a table view, and both
  respond to keyboard focus as well as hover.
- `npm audit` reports moderate advisories under `@google-analytics/data` →
  `google-gax` → `uuid`. They concern `uuid` v3/v5/v6 called with a `buf`
  argument; `google-gax` uses v4, so the affected code path is never reached.
  Clearing them needs an upstream release.
