# Office Screen

Static digital signage for a portrait (phone-shaped) screen. Plain HTML/CSS/JS, no build step, hosted on GitHub Pages.
Rotates **Schedule → Upcoming Events → Quote of the Day** (20 s / 15 s / 15 s, 300 ms crossfade), with a live
Phoenix clock and a gold dot indicator. Schedule and time-off changes arrive from a weekly Google Form.

```
index.html  style.css  app.js
data/schedule.txt   weekly schedule (Form writes here; hand-editable)
data/timeoff.txt    time off (Form appends here; hand-editable)
data/events.txt     events (hand-edited)
data/quote.json     quote of the day (written daily by the Action)
.github/workflows/fetch-quote.yml
```

## 1. Publish as a private repo + GitHub Pages

Pages on a **private** repo requires GitHub Pro, Team or Enterprise. Pro is free for students via the
GitHub Student Developer Pack (education.github.com). The repo stays private, but the **website itself is public**
to anyone who has the URL (including `data/*.txt`). It isn't indexed by search engines (`noindex`).

**Quickest (GitHub CLI):** from this folder run `bash publish-private.sh`. It creates the private repo, pushes `main`,
and turns on Pages. Install the CLI first if needed: `brew install gh`.

**Or by hand:**
1. github.com/new → name `office-signage` → **Private** → leave README/.gitignore unticked → *Create repository*.
2. In this folder: `git remote add origin https://github.com/<you>/office-signage.git && git push -u origin main`
3. Repo **Settings → Pages →** Source: *Deploy from a branch*, Branch `main`, folder `/ (root)` → Save.

To let others edit `data/` files in the GitHub web editor, add them under **Settings → Collaborators**.

## Accessing the site

- URL: `https://<you>.github.io/office-signage/` (shown under Settings → Pages; the first deploy takes about a minute).
- **iPhone:** open the URL in Safari → Share → *Add to Home Screen* → launch from the icon (full screen).
  Lock it to the app with *Settings → Accessibility → Guided Access*, and set *Display → Auto-Lock → Never*.
- **Android:** Chrome → ⋮ → *Add to Home screen*, or use a kiosk browser (e.g. Fully Kiosk) with the URL as its
  start page; turn on *Stay awake while charging* in Developer options.
- Keep the phone on a charger. The page refreshes data every 5 minutes and reloads itself at 2 AM.

## 2. Quote of the Day Action

Runs daily at 12:23 AM and 6:23 AM Phoenix, or on demand from **Actions → Fetch quote of the day → Run workflow**.
It reads BrainyQuote's official RSS feed (`https://www.brainyquote.com/link/quotebr.rss`, the feed behind
`/feeds/todays_quote`), writes `data/quote.json`, commits only if the quote changed, and asks Pages to rebuild.

- If the run fails with a permissions error: **Settings → Actions → General → Workflow permissions → Read and write**.
- If BrainyQuote ever blocks the runner, the job goes red and the screen quietly uses the 8 fallback quotes in `app.js`
  (also used whenever `quote.json` is more than 2 days old).
- GitHub pauses scheduled workflows in repos with no activity for 60 days; the Form's commits count as activity.

## 3. Google Form + Apps Script

1. Create a Google Sheet (e.g. "Office Screen Responses"). **Extensions → Apps Script**, paste `Code.gs`, save.
2. Create a GitHub **fine-grained personal access token**: *Settings → Developer settings → Fine-grained tokens →
   Generate*. Repository access: **Only select repositories → this repo**. Permissions: **Contents → Read and write**
   (Metadata: read is added automatically). Note the expiry date and set a reminder to rotate it.
3. In Apps Script: **Project Settings → Script Properties → Add**: `GITHUB_TOKEN` = the token.
4. Edit `CONFIG` at the top of `Code.gs`: `GITHUB_OWNER`, `GITHUB_REPO`, the four reminder e-mail addresses, `SIGNAGE_URL`.
5. Run **`setup()`** once and approve the permissions. The log prints the Form link. It creates the Form (Name dropdown;
   "This week's schedule changes" section with Mon–Fri overrides; "Time off" section with start, end, note), links
   responses to this Sheet, and installs two triggers: on-submit sync, and the Thursday ~9:00 AM reminder.
6. Check with `testGitHubConnection()` (prints `schedule.txt`) and `sendWeeklyReminderNow()`.

What a submission does:

| Form answer | Commit |
|---|---|
| Name = Vignesh, Wednesday override = `Half day` | `Vignesh: Half day` under `Wednesday:` in `schedule.txt`, replacing Vignesh's line in that block (or inserting it). Nothing else in the file changes. |
| Name = Julia, Friday override = `Not Scheduled` | `Julia: Not Scheduled` under `Friday:`; this overrides Julia's fixed Friday row for that day. |
| Name = Balaji, time off Oct 10 → Oct 12, 2026 | `Balaji: Oct 10 - Oct 12, 2026` appended to `timeoff.txt` (identical lines aren't duplicated). |

Blank, `-`, `same`, `n/a` or `unchanged` answers are ignored. Each file is committed once per submission via
`PUT /repos/{owner}/{repo}/contents/{path}`; Pages redeploys and the screen picks it up on its next 5-minute refresh.
If a sync fails, the script owner gets an e-mail; fix the cause, then run `resyncRow(<row number>)`.

The time-off **note** stays in the Sheet and is not shown on the screen. Set `SHOW_TIMEOFF_NOTE_ON_SCREEN: true` to show it
in parentheses, e.g. `Vignesh: Oct 10 - Oct 12, 2026 (Conference)`.

## Data file formats

Lines starting with `# ` (hash + space) are comments in every `.txt` file.

**schedule.txt**: `Day:` header, then `Name: value` lines, blank line between days. Value is a time range, `Not Scheduled`
(any case), or any other text, which is shown exactly as typed. No line for a person under a day → not shown that day.
Julia (Tue–Fri 7:30–5:30) and Melissa (Mon–Fri 8–5) are fixed rows from `CONFIG.FIXED_STAFF` in `app.js`.
The file has no dates: the screen shows the current Mon–Fri, and on Saturday/Sunday it shows the coming week.

**timeoff.txt**: `Name: date` or `Name: start - end`. Accepted: `Nov 3, 2026`, `Oct 10 - Oct 12, 2026`, `Oct 10-12, 2026`,
`Dec 28, 2026 - Jan 2, 2027`, `10/10/2026 - 10/12/2026`. Past entries hide; up to 8 upcoming, soonest first.
Anyone on time off that day shows "Time Off" in the schedule (`TIMEOFF_OVERRIDES_SCHEDULE` in `app.js`).

**events.txt**: first line is the title (`Japanese Film Festival:`), then `Dates:`, `Timings:`, `Student Worker:`
(any extra `Key: value` lines are shown too). Blank line between events. Events without a readable `Dates:` line are skipped.

**quote.json**: `{ "date": "YYYY-MM-DD", "text": "...", "author": "..." }` (+ `link`, `source`, `fetchedAt`).

Any file can still be edited by hand in GitHub's web editor (pencil icon → edit → commit).

## Behaviour notes

- **Auto-fit:** each view scales its text to fill the screen. If Schedule + Time Off can't fit at ≥ 90% of the base size,
  the schedule slot splits: day list for 12 s, then Time Off for 8 s.
- **Failures:** a file that 404s or can't be parsed shows a calm "… unavailable — retrying…" card for that view only,
  retried every 5 minutes. A brief network drop keeps the last good copy on screen instead.
- **Daily reload** at 2:00 AM Phoenix, only once the site answers, so an outage never leaves a browser error page.
- Screen wake lock where supported, and a ~1 px shift every 10 minutes to limit OLED burn-in.

## Local preview and testing

```
python3 -m http.server 8000     # then open http://localhost:8000
```
URL parameters: `?view=schedule|events|quote` (pin one view), `?date=2026-10-07` (pretend today is that date),
`?speed=5` (rotate 5× faster).
