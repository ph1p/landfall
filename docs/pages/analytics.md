# Analytics

`lf analytics` counts visitors on your sites with a small collector on your own server.
It shows pageviews, visitors, where they come from, which paths they take, how far they scroll, where they drop off, custom events, when and from which countries they visit, and how fast pages feel (Core Web Vitals).
Nothing is sent to another company.
By default it sets no cookie and stores no IP address.

Analytics is a [built-in plugin](plugins.md). It is off until you turn it on for a site.

## How it works

- `lf analytics enable <site>` starts one container, `lf-analytics`, on the server.
- Traefik hands every request for `/_lf/a/` on the site's domains to that container.
  The site itself needs no change besides one script tag.
- The page loads `/_lf/a/s.js` from its own domain. The script reports pageviews, engaged time, scroll depth, events and web vitals to `/_lf/a/e`.
- The collector stores them in SQLite, in `/opt/landfall/analytics/data/analytics.db`.
- It keeps 365 days of data and deletes older hits on its own. [Storage](#storage) changes that.
- It ignores bots, crawlers, monitors and command-line clients.

Everything is a plain Compose project under `/opt/landfall/analytics`. Its README says what each file is.

## Turn it on

```sh
# collect on all domains of the site shop
lf analytics enable shop
# only on one domain
lf analytics enable shop --domain shop.example.com
```

Then add this tag to the `<head>` of every page:

```html
<script src="/_lf/a/s.js" defer></script>
```

- Without `--domain`, landfall takes the domains of the site's Traefik routers. The site must be running.
- A domain belongs to one site only.
- `enable` again adds or changes domains and keeps the cookie mode.
- The panel in `lf ui` (server page, Monitoring, Analytics) checks that each site's home page loads the script.

Exclude your own visits in your browser:

```js
// in the browser console, on your site
localStorage.setItem("lfa:ignore", "1");
```

## Read the numbers

```sh
# visitors, pages, sources, journeys, funnels, events, devices and web vitals of all sites, last 7 days
lf analytics report
# one site, last 30 days
lf analytics report shop --days 30
# where visitors of /pricing came from and where they went next
lf analytics path shop /pricing
# custom events, outbound links and downloads
lf analytics events shop
# Core Web Vitals per site, device and page (alias: lf vitals)
lf analytics vitals shop
# the panel as text, with charts as bars; --view 7, 30 or 90 days
lf analytics --view 30
```

All read commands take `--days` (1 to 400) and `--json`.

`lf analytics report` prints the panel of the web UI as text: the same numbers, tables and charts.
It leaves out the buttons and the install snippet.
`--json` gives the raw numbers instead.

What the numbers mean:

- **Visitor**: one person on one site. Without a cookie, one person counts once per day (see [Cookies](#cookies)).
- **Returning**: visitors seen before the range, or on more than one day in it. Only sites with a cookie count them.
- **Session**: a visit. It ends after 30 minutes without a hit.
- **Bounce**: a session with one pageview.
- **Time**: engaged time, only while the tab is visible.
- **Sources**: the referring site, or `utm_source` / `ref` in the link.
- **Campaigns**: `utm_source`, `utm_medium` and `utm_campaign`.
- **Journeys**: the most common page paths within a session.
- **Scroll**: how far down a page visitors scrolled, on average. Each session counts its deepest point on that page.
- **Countries**: from `CF-IPCountry` or `X-Country-Code` when a proxy in front sends one. Else from the browser's time zone, for example `Europe/Berlin` is Germany.
  landfall does no IP lookup. A visitor on a VPN or with a wrong clock can show up in another country. The panel shows the first 10 and lists all on request.
- **When**: pageviews per hour of the day and per day of the week, in UTC.
- **Web vitals**: the 75th percentile of LCP, INP, CLS, FCP and TTFB. Good and poor follow Google's thresholds.

Every number compares with the same number of days before.

### Only with a cookie

Sites in mode `on` or `consent` also get a Loyalty section.
Only a cookie recognizes a visitor from one day to the next, so these numbers need it.

- **Visits per visitor**: how many visitors came once, twice, 3 to 5 times, and more.
- **First visit came from**: the source of each visitor's very first visit, and how many of them came back on another day.
- **Retention**: visitors first seen in a week, and the share of them seen again 1, 2, 3… weeks later. It needs a range of at least 14 days.

It counts only visitors with the cookie. Visitors before consent and browsers with Global Privacy Control are left out.

## Events

The script counts these on its own:

- pageviews, also page changes of single-page apps (`history.pushState`)
- clicks on links to other sites (`Outbound link`)
- clicks on downloads such as `.pdf` or `.zip` (`Download`)

Count your own events from code, or with an attribute:

```js
// from your code, with optional properties
lfa("Signup", { plan: "pro" });
```

```html
<!-- on click, without code -->
<button data-lfa="Signup">Sign up</button>
```

Events sent before the script loaded are kept with this stub in front of the script tag:

```html
<script>window.lfa = window.lfa || function () { (lfa.q = lfa.q || []).push(arguments); };</script>
```

## Funnels

A funnel counts how many sessions reach each step, in order.
A step is a page (`*` matches anything) or `event:Name`.

```sh
# from the home page to pricing to a signup event
lf analytics funnel shop signup / /pricing event:Signup
# blog posts to the newsletter page
lf analytics funnel shop newsletter '/blog/*' /newsletter
# list the funnels with their numbers
lf analytics funnels shop
# remove one (the collected data stays)
lf analytics funnel shop signup --rm
```

- A funnel has 2 to 10 steps.
- It counts data that was already collected, too.
- Funnels live in `/opt/landfall/analytics/funnels.json`.

## Cookies

Each site has a cookie mode. Set it with `--cookie` on `enable`:

```sh
# no cookie (the default)
lf analytics enable shop --cookie off
# a cookie from the first visit
lf analytics enable shop --cookie on
# a cookie only after the visitor agreed
lf analytics enable shop --cookie consent
```

| mode | what is stored in the browser | visitors | returning visitors |
|---|---|---|---|
| `off` | nothing | counted per day | not counted |
| `on` | cookie `lfa_id` for 12 months | recognized across days | counted |
| `consent` | nothing until `lfa.consent()`, then like `on` | per day until consent | counted after consent |

### Without a cookie (`off`)

- The collector hashes the IP address and the browser's user agent with a random salt.
- The salt lives only in memory. It is replaced every day at midnight UTC.
- So the same person counts as a new visitor each day, and cannot be followed from one day to the next.
- The IP address and the user agent are never written to disk.

### With a cookie (`on`)

- The script stores a random id in the first-party cookie `lfa_id` for 12 months.
- The collector counts the visitor by a hash of the site and that id.
- The cookie holds no personal data and is sent only to your own domain.
- A browser with Global Privacy Control turned on gets no cookie. It is counted as in mode `off`.

### With consent (`consent`)

The script sets the cookie only after your consent banner says yes:

```js
// the visitor agreed
lfa.consent();
// the visitor withdrew: deletes the cookie
lfa.consent(false);
```

- Until then, the visitor is counted as in mode `off`.
- `lfa.consent()` exists once the script has loaded. A banner that answers earlier can wait for the page's `load` event.
- On a later visit, an existing cookie is used without calling `lfa.consent()` again.
- `lfa.consent()` does nothing on a site in mode `off`.

### EU and GDPR

This is not legal advice. Check with whoever handles privacy for your sites.

- The ePrivacy Directive requires consent before storing anything in a visitor's browser that the site does not strictly need.
  An analytics cookie is not strictly needed. So in the EU, mode `on` needs consent.
- Use mode `consent` in the EU and call `lfa.consent()` from your consent banner.
- Mode `off` stores nothing in the browser. Many sites run such cookieless analytics without a banner.
  It still processes IP addresses for a moment, so name the analytics in your privacy policy.
- In every mode, the script reads the screen width, the browser's language and time zone, and how far the page is scrolled.
  It sends them with each pageview. Some regulators treat reading such device details like storing a cookie. Name them in your privacy policy too.
- The country comes from the time zone or a proxy header. landfall never looks up the IP address.
- The Loyalty numbers follow one visitor across days. They exist only in modes `on` and `consent`, after the visitor agreed.
- All data stays on your server. There is no third party to name as a processor.

### Changing the mode

- A visitor who gets the cookie in the middle of a day can count twice that day: once by the daily hash, once by the cookie.
  The same happens when you switch a site from `off` to `on`, and when a visitor withdraws consent.
- Returning visitors are counted from the day the cookie was set. Earlier days count every visitor as new.
- Switching to `off` stops reading the cookie. Browsers keep it until it expires; `lfa.consent(false)` deletes it.

## Export

`lf analytics export` prints every stored hit, one row each, oldest first.
It writes CSV to stdout. Redirect it into a file.

```sh
# every hit of every site, as CSV
lf analytics export > analytics.csv
# one site, the last 30 days
lf analytics export shop --days 30 > shop.csv
# JSON lines instead of CSV
lf analytics export shop --format jsonl > shop.jsonl
```

The columns are `time`, `site`, `session`, `visitor`, `kind`, `path`, `name`, `value`, `props`, `referrer`,
`utm_source`, `utm_medium`, `utm_campaign`, `country`, `lang`, `browser`, `os` and `device`.

- `time` is ISO 8601 in UTC.
- `kind` is `pv` (pageview), `ev` (event), `vt` (web vital), `lv` (engaged time when the page is left) or `sd` (scroll depth).
- `name` is the event or the vital. `value` is the vital's value, the engaged seconds or the scroll percent.
- `props` is the event's properties as JSON.
- A cell that starts with `=`, `+`, `-` or `@` gets a `'` in front, so a spreadsheet shows it instead of running it.

The export reads the data and changes nothing.
It contains what the collector stored, so treat the file like the database.

## Storage

The collector keeps 365 days of data by default and has no size limit.
`lf analytics storage` shows and changes that.

```sh
# how long data is kept and how much it takes now
lf analytics storage
# keep 90 days
lf analytics storage --keep-days 90
# also keep at most 500 MB: the oldest days go first
lf analytics storage --max-size 500M
# no size limit again
lf analytics storage --max-size off
```

- `--keep-days` takes 1 to 3650. Older hits are deleted.
- `--max-size` takes a size like `500M` or `2G`, at least `10M`, or `off`.
  While the data is larger, the collector deletes the oldest day. It never deletes today's hits.
- The file does not shrink. SQLite reuses the freed space, so it stops growing at about the limit.
- The settings live in `/opt/landfall/analytics/app/storage.json`. The collector reads them every minute and applies a change at once.
  Otherwise it checks once an hour.
- Changing the settings is undoable with `lf undo`. The hits deleted in the meantime are gone.
- Keeping less asks first. `-y` answers.

The panel shows the settings under the numbers. Its **Storage** button offers common values: 30 days to 5 years, and 100 MB to 20 GB.
Other values are set with the command.

## Turn it off

```sh
# stop collecting for shop; its data stays
lf analytics disable shop
# also delete its collected data (cannot be undone)
lf analytics disable shop --purge
```

- Remove the script tag from the site's pages afterwards. Traefik then sends `/_lf/a/` to the site itself, which usually answers 404.
- When no site collects anymore, the collector container stops.
- `lf undo` turns collection back on. It cannot bring back data deleted with `--purge`.

### Uninstall

Remove analytics from the server completely:

```sh
# stop every site, remove the collector and /opt/landfall/analytics with all collected data
lf analytics uninstall
# the same, but keep the collected data and funnels for a later enable
lf analytics uninstall --keep-data
```

- It asks first. `-y` answers.
- It removes the container and the files. The `node:22-alpine` image stays; `lf prune --all` removes it when nothing else uses it.
- Traefik then sends `/_lf/a/` to the sites themselves. Remove the script tag from their pages.
- It cannot be undone. With `--keep-data`, `lf analytics enable <site>` starts a new collector that reads the kept data.
- It also works when Docker is gone.

## When something is wrong

```sh
# rewrite the collector's files and start it again
lf analytics repair
```

- Run it after an error, or after updating landfall to get a newer collector.
- The panel in `lf ui` names each problem it finds: Docker missing, a collector that keeps restarting with its log, a page without the script tag, a domain where `/_lf/a/s.js` does not answer 200.
- `enable`, `disable`, `repair` and `funnel` are journaled: `lf history` lists them and `lf undo` reverts them.
- `uninstall` is journaled too, but cannot be undone.
