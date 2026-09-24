/*
 * Office signage — app.js
 * Plain JS, no framework, no build step. Served as a static GitHub Pages site.
 * Rotation: Schedule -> Upcoming Events -> Quote of the Day -> repeat.
 *
 * Debug URL parameters (handy for testing, harmless in production):
 *   ?view=schedule|events|quote   pin one view
 *   ?date=2026-10-07              pretend "today" is this date (Phoenix)
 *   ?speed=5                      run the rotation 5x faster
 */
(function (root) {
  'use strict';

  /* ================================================================== *
   * CONFIG — everything you are likely to tweak lives here.
   * ================================================================== */
  var CONFIG = {
    TIMEZONE: 'America/Phoenix',

    // The rotation runs only during office hours (Phoenix time). Outside them the
    // screen shows a minimal full-screen clock.
    ACTIVE_HOURS: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '17:30' },
    IDLE_DRIFT_MS: 60 * 1000,         // idle clock moves slightly every minute (limits burn-in)

    VIEW_ORDER: ['schedule', 'events', 'quote'],
    VIEW_DURATION_MS: { schedule: 20000, events: 15000, quote: 15000 },
    // If Schedule + Time Off don't fit at a readable size, the schedule slot is
    // split: day list first, then Time Off. This is the day list's share.
    SCHEDULE_SPLIT_RATIO: 0.6,
    // If the events don't fit on one screen at a readable size they are split
    // into pages; each page stays up this long (the Events slot grows to match).
    EVENTS_PAGE_MS: 10000,
    FADE_MS: 300,

    REFRESH_MS: 5 * 60 * 1000,        // re-fetch every data file
    FETCH_TIMEOUT_MS: 15000,
    RELOAD_HOUR: 2,                   // full page reload once a day, 2:00 AM Phoenix
    RELOAD_RETRY_MS: 5 * 60 * 1000,   // if the network is down at reload time, wait and retry

    DATA_FILES: {
      schedule: 'data/schedule.txt',
      timeoff: 'data/timeoff.txt',
      events: 'data/events.txt',
      quote: 'data/quote.json'
    },

    EVENTS_MAX: 8,                    // upcoming events shown (cards shrink, then page)
    TIMEOFF_MAX: 8,
    QUOTE_MAX_AGE_DAYS: 2,            // older quote.json -> use the fallback list

    // Auto-fit: multiplier on the base type size from style.css.
    FIT: {
      READABLE_MIN: 0.9,  // Schedule + Time Off must fit at >= this, otherwise split
      FLOOR: 0.7,         // never shrink below this (very small screens)
      MAX: 1.6,           // grow text when there is spare room
      QUOTE_MAX: 2.4
    },

    // Rows from schedule.txt are shown in this order; unknown names follow.
    ROSTER_ORDER: ['Vignesh', 'Balaji'],

    // Fixed rows shown below the schedule.txt rows every day.
    // A line for the same name under a day in schedule.txt (e.g. written by the
    // Google Form) replaces the fixed value for that day only.
    FIXED_STAFF: [
      { name: 'Julia', days: ['tue', 'wed', 'thu', 'fri'], hours: '7:30 AM – 5:30 PM' },
      { name: 'Melissa', days: ['mon', 'tue', 'wed', 'thu', 'fri'], hours: '8:00 AM – 5:00 PM' }
    ],

    // When someone has time off on a day this week, their row reads "Time Off".
    TIMEOFF_OVERRIDES_SCHEDULE: true,

    // OLED care: the whole screen drifts slowly and continuously, sweeping up to
    // X_VW % of the width and Y_VH % of the height either way, so no text edge,
    // divider or clock digit sits on the same pixels for long. STEP_MS 0 = off.
    OLED_ORBIT: { X_VW: 2, Y_VH: 1.2, STEP_MS: 5000 }
  };

  // Funny fallbacks, shown when data/quote.json is missing, malformed, or stale. Rotates daily.
  var FALLBACK_QUOTES = [
    { text: 'I love deadlines. I love the whooshing noise they make as they go by.', author: 'Douglas Adams' },
    { text: 'Time is an illusion. Lunchtime doubly so.', author: 'Douglas Adams' },
    { text: 'I can resist everything except temptation.', author: 'Oscar Wilde' },
    { text: 'I am so clever that sometimes I don’t understand a single word of what I am saying.', author: 'Oscar Wilde' },
    { text: 'Never put off till tomorrow what may be done day after tomorrow just as well.', author: 'Mark Twain' },
    { text: 'Knowledge is knowing a tomato is a fruit; wisdom is not putting it in a fruit salad.', author: 'Miles Kington' },
    { text: 'My fake plants died because I did not pretend to water them.', author: 'Mitch Hedberg' },
    { text: 'The trouble with having an open mind, of course, is that people will insist on coming along and trying to put things in it.', author: 'Terry Pratchett' }
  ];

  /* ================================================================== *
   * Calendar math — dates are integer day numbers (days since 1970-01-01),
   * always computed in America/Phoenix, never from the device's own zone.
   * ================================================================== */
  var DAY_MS = 86400000;
  var WORK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
  var DAY_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  var WEEKDAY_BY_INDEX = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS_LONG = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december'];
  var MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_TITLE = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function dayNum(y, m0, d) {
    if (y === null || m0 === null || d === null || isNaN(y) || isNaN(m0) || isNaN(d)) return null;
    var t = Date.UTC(y, m0, d);
    var dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m0 || dt.getUTCDate() !== d) return null;
    return Math.round(t / DAY_MS);
  }

  function ymdOf(n) {
    var dt = new Date(n * DAY_MS);
    return { y: dt.getUTCFullYear(), m0: dt.getUTCMonth(), d: dt.getUTCDate() };
  }

  function weekdayOf(n) { return ((n % 7) + 11) % 7; } // 0 = Sunday (1970-01-01 was a Thursday)

  // Mon of the week to display. On Sat/Sun the office is closed, so show next week.
  function weekMonday(todayN) {
    var dow = weekdayOf(todayN);
    if (dow === 6) return todayN + 2;
    if (dow === 0) return todayN + 1;
    return todayN - (dow - 1);
  }

  function hhmmToMinutes(s) {
    var p = String(s).split(':');
    return (+p[0]) * 60 + (+p[1] || 0);
  }

  // parts = {y, m0, d, h, mi} in Phoenix time -> is the office open (rotation on)?
  function officeOpen(parts) {
    var H = CONFIG.ACTIVE_HOURS;
    var key = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][weekdayOf(dayNum(parts.y, parts.m0, parts.d))];
    if (H.days.indexOf(key) < 0) return false;
    var m = parts.h * 60 + parts.mi;
    return m >= hhmmToMinutes(H.start) && m < hhmmToMinutes(H.end);
  }

  var partsFmt = null;
  function phoenixParts(date) {
    if (!partsFmt) {
      partsFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: CONFIG.TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
      });
    }
    var out = {};
    partsFmt.formatToParts(date || new Date()).forEach(function (p) { out[p.type] = p.value; });
    var h = parseInt(out.hour, 10);
    if (h === 24) h = 0;
    return { y: +out.year, m0: +out.month - 1, d: +out.day, h: h, mi: +out.minute, s: +out.second };
  }

  var debugToday = null;
  function todayNum() {
    if (debugToday !== null) return debugToday;
    var p = phoenixParts();
    return dayNum(p.y, p.m0, p.d);
  }

  /* ================================================================== *
   * Date-range parsing (shared by Time Off and Events)
   * Accepts: "Oct 10 - Oct 12, 2026", "Nov 3, 2026", "Oct 10-12, 2026",
   * "Dec 28, 2026 - Jan 2, 2027", "Dec 28 - Jan 2, 2027", "October 3 to 5",
   * "Mon, Oct 10 - Wed, Oct 12", "10/10/2026 - 10/12/2026", "2026-10-10".
   * ================================================================== */
  function monthFromName(s) {
    s = String(s).toLowerCase().replace(/\.$/, '');
    if (s.length < 3) return -1;
    for (var i = 0; i < 12; i++) if (MONTHS_LONG[i].indexOf(s) === 0) return i;
    return -1;
  }

  var WEEKDAY_PREFIX_RE = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+/i;

  function parseDatePart(str) {
    var s = String(str).trim().replace(/[.,\s]+$/, '').replace(WEEKDAY_PREFIX_RE, '');
    var m, mi;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) {
      return { y: +m[1], m0: +m[2] - 1, d: +m[3] };
    }
    if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?$/.exec(s))) {
      return { y: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null, m0: +m[1] - 1, d: +m[2] };
    }
    if ((m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/i.exec(s))) {
      mi = monthFromName(m[1]);
      return mi < 0 ? null : { y: m[3] ? +m[3] : null, m0: mi, d: +m[2] };
    }
    if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?(?:,?\s+(\d{4}))?$/i.exec(s))) {
      mi = monthFromName(m[2]);
      return mi < 0 ? null : { y: m[3] ? +m[3] : null, m0: mi, d: +m[1] };
    }
    if ((m = /^(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(s))) {
      return { y: m[2] ? +m[2] : null, m0: null, d: +m[1] }; // "12, 2026" in "Oct 10 - 12, 2026"
    }
    return null;
  }

  function parseDateRange(str, todayN) {
    var s = String(str || '').replace(/[–—−]/g, '-').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    var a, b, parts;
    var single = parseDatePart(s);
    if (single && single.m0 !== null) {
      a = single;
      b = { y: single.y, m0: single.m0, d: single.d };
    } else {
      parts = s.split(/\s+(?:-+|to|through|thru|until)\s+/i);
      if (parts.length !== 2) parts = s.split(/\s*-+\s*/);
      if (parts.length !== 2) return null;
      a = parseDatePart(parts[0]);
      b = parseDatePart(parts[1]);
      if (!a || !b) return null;
      if (a.m0 === null && b.m0 === null) return null;
      if (b.m0 === null) b.m0 = a.m0;
      if (a.m0 === null) a.m0 = b.m0;
    }

    var yearGiven = a.y !== null || b.y !== null;
    var ya, yb, aInherited = false;
    if (yearGiven) {
      ya = a.y !== null ? a.y : b.y;
      yb = b.y !== null ? b.y : a.y;
      aInherited = a.y === null;
    } else {
      ya = yb = ymdOf(todayN).y;
    }

    var start = dayNum(ya, a.m0, a.d);
    var end = dayNum(yb, b.m0, b.d);
    if (start === null || end === null) return null;

    if (end < start) {
      if (aInherited) { ya -= 1; start = dayNum(ya, a.m0, a.d); }       // "Dec 28 - Jan 2, 2027"
      else if (!yearGiven) { yb += 1; end = dayNum(yb, b.m0, b.d); }     // "Dec 28 - Jan 2"
      else { var t = start; start = end; end = t; }                       // typed backwards
      if (start === null || end === null) return null;
    }

    // No year anywhere: pick the occurrence that isn't long past ("Jan 5" typed in December).
    if (!yearGiven && end < todayN - 180) {
      var s2 = dayNum(ya + 1, a.m0, a.d), e2 = dayNum(yb + 1, b.m0, b.d);
      if (s2 !== null && e2 !== null) { start = s2; end = e2; }
    }
    return { start: start, end: end };
  }

  /* ================================================================== *
   * File parsers — pure functions, throw on unusable input.
   * Lines starting with "# " (hash + space) are comments in every .txt file.
   * ================================================================== */
  function isComment(line) { return /^#(\s|$)/.test(line); }

  function splitLines(text) { return String(text || '').replace(/^﻿/, '').split(/\r?\n/); }

  var DAY_HEADER_RE = /^(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s*:\s*$/i;

  // schedule.txt -> { mon: [{name, value}], tue: [...], ... }
  function parseSchedule(text) {
    var days = {};
    var current = null;
    var sawHeader = false;
    splitLines(text).forEach(function (raw) {
      var line = raw.trim();
      if (!line || isComment(line)) return;
      var h = DAY_HEADER_RE.exec(line);
      if (h) {
        current = h[1].slice(0, 3).toLowerCase();
        if (!days[current]) days[current] = [];
        sawHeader = true;
        return;
      }
      var m = /^([^:]+?)\s*:\s*(.*)$/.exec(line);
      if (!m || !current) return;             // stray line: ignore
      var name = m[1].trim();
      var value = m[2].trim();
      if (!value) return;                      // "Name:" with nothing -> not shown
      var list = days[current];
      for (var i = 0; i < list.length; i++) {
        if (sameName(list[i].name, name)) { list[i] = { name: name, value: value }; return; }
      }
      list.push({ name: name, value: value });
    });
    if (!sawHeader) throw new Error('schedule.txt: no "Monday:"-style day headers found');
    return days;
  }

  // timeoff.txt -> [{name, when, note}] (dates resolved at render time)
  function parseTimeOff(text) {
    var out = [];
    splitLines(text).forEach(function (raw) {
      var line = raw.trim();
      if (!line || isComment(line)) return;
      var m = /^([^:]+?)\s*:\s*(.+)$/.exec(line);
      if (!m) return;
      var when = m[2].trim();
      var note = '';
      var n = /\s*\(([^)]*)\)\s*$/.exec(when);
      if (n) { note = n[1].trim(); when = when.slice(0, n.index).trim(); }
      out.push({ name: m[1].trim(), when: when, note: note });
    });
    return out;
  }

  // events.txt -> [{title, fields:[{key,value}], dates}]
  function parseEvents(text) {
    var blocks = [];
    var cur = null;
    splitLines(text).forEach(function (raw) {
      var line = raw.trim();
      if (isComment(line)) return;
      if (!line) { cur = null; return; }
      if (!cur) { cur = []; blocks.push(cur); }
      cur.push(line);
    });
    return blocks.map(function (lines) {
      var first = /^([^:]+?)\s*:\s*(.*)$/.exec(lines[0]);
      var title;
      if (first && first[2] && /^(event|title|name)$/i.test(first[1])) title = first[2];
      else title = lines[0].replace(/\s*:\s*$/, '');
      var fields = [];
      var dates = '';
      for (var i = 1; i < lines.length; i++) {
        var m = /^([^:]+?)\s*:\s*(.*)$/.exec(lines[i]);
        if (!m || !m[2]) continue;
        fields.push({ key: m[1].trim(), value: m[2].trim() });
        if (/^dates?$/i.test(m[1].trim())) dates = m[2].trim();
      }
      return { title: title, fields: fields, dates: dates };
    });
  }

  // quote.json -> {text, author, date?, link?, source?}
  function parseQuote(text) {
    var q = JSON.parse(text);
    if (!q || typeof q.text !== 'string' || typeof q.author !== 'string' || !q.text.trim() || !q.author.trim()) {
      throw new Error('quote.json: needs non-empty "text" and "author"');
    }
    return q;
  }

  /* ================================================================== *
   * View models
   * ================================================================== */
  function sameName(a, b) {
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  }
  function samePerson(a, b) {
    var fa = String(a).trim().toLowerCase().split(/\s+/)[0];
    var fb = String(b).trim().toLowerCase().split(/\s+/)[0];
    return fa === fb;
  }

  var TIME_SRC = '\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?\\s?m\\.?)?';
  var TIME_RANGE_RE = new RegExp('^(' + TIME_SRC + ')\\s*(?:-+|\\u2013|\\u2014|to)\\s*(' + TIME_SRC + ')$', 'i');

  function classifyValue(v) {
    var t = String(v).trim();
    if (/^not\s+scheduled\.?$/i.test(t)) return { kind: 'none', text: 'Not Scheduled' };
    var m = TIME_RANGE_RE.exec(t);
    if (m) return { kind: 'hours', text: m[1].trim() + ' – ' + m[2].trim() };
    return { kind: 'note', text: t };   // override text: shown exactly as typed
  }

  function rosterRank(name) {
    for (var i = 0; i < CONFIG.ROSTER_ORDER.length; i++) {
      if (sameName(CONFIG.ROSTER_ORDER[i], name)) return i;
    }
    return 100;
  }

  function resolveTimeOff(entries, todayN) {
    var resolved = [];
    var bad = 0;
    (entries || []).forEach(function (e) {
      var r = parseDateRange(e.when, todayN);
      if (!r) { bad++; return; }
      resolved.push({ name: e.name, note: e.note, start: r.start, end: r.end });
    });
    if (entries && entries.length && !resolved.length) {
      throw new Error('timeoff.txt: no line had a readable date');
    }
    var upcoming = resolved.filter(function (e) { return e.end >= todayN; });
    upcoming.sort(function (a, b) {
      return a.start - b.start || a.end - b.end || a.name.localeCompare(b.name);
    });
    var shown = upcoming.slice(0, CONFIG.TIMEOFF_MAX);
    return { all: resolved, upcoming: shown, more: upcoming.length - shown.length, bad: bad };
  }

  function isOffOn(resolved, name, n) {
    for (var i = 0; i < resolved.length; i++) {
      var e = resolved[i];
      if (n >= e.start && n <= e.end && samePerson(e.name, name)) return true;
    }
    return false;
  }

  function buildWeek(schedDays, timeoffAll, todayN) {
    var monday = weekMonday(todayN);
    return WORK_DAYS.map(function (key, i) {
      var date = monday + i;
      var fileRows = (schedDays && schedDays[key]) || [];
      var rows = [];

      var free = fileRows
        .map(function (r, idx) { return { r: r, idx: idx }; })
        .filter(function (x) {
          return !CONFIG.FIXED_STAFF.some(function (s) { return sameName(s.name, x.r.name); });
        })
        .sort(function (a, b) { return rosterRank(a.r.name) - rosterRank(b.r.name) || a.idx - b.idx; });
      free.forEach(function (x) {
        var c = classifyValue(x.r.value);
        rows.push({ name: x.r.name, kind: c.kind, text: c.text });
      });

      CONFIG.FIXED_STAFF.forEach(function (s) {
        var override = null;
        fileRows.forEach(function (r) { if (sameName(r.name, s.name)) override = r; });
        if (override) {
          var c = classifyValue(override.value);
          rows.push({ name: s.name, kind: c.kind, text: c.text });
        } else if (s.days.indexOf(key) >= 0) {
          rows.push({ name: s.name, kind: 'hours', text: s.hours });
        }
      });

      if (CONFIG.TIMEOFF_OVERRIDES_SCHEDULE && timeoffAll && timeoffAll.length) {
        rows.forEach(function (r) {
          if (r.kind !== 'none' && isOffOn(timeoffAll, r.name, date)) { r.kind = 'off'; r.text = 'Time Off'; }
        });
      }

      return { key: key, date: date, isToday: date === todayN, isPast: date < todayN, rows: rows };
    });
  }

  function resolveEvents(events, todayN) {
    var dated = [];
    (events || []).forEach(function (ev) {
      var r = parseDateRange(ev.dates, todayN);
      if (r) dated.push({ ev: ev, start: r.start, end: r.end });
    });
    if (events && events.length && !dated.length) {
      throw new Error('events.txt: no event had a readable "Dates:" line');
    }
    var upcoming = dated.filter(function (x) { return x.end >= todayN; });
    upcoming.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return upcoming.slice(0, CONFIG.EVENTS_MAX);
  }

  function pickQuote(stored, todayN) {
    if (stored && stored.ok && stored.data) {
      var q = stored.data;
      var fresh = true;
      if (q.date) {
        var r = parseDateRange(q.date, todayN);
        fresh = !!r && todayN - r.start <= CONFIG.QUOTE_MAX_AGE_DAYS && r.start - todayN <= 1;
      }
      if (fresh) {
        return {
          text: cleanQuoteText(q.text), author: q.author.trim(),
          source: q.source || null, fallback: false
        };
      }
    }
    var f = FALLBACK_QUOTES[((todayN % FALLBACK_QUOTES.length) + FALLBACK_QUOTES.length) % FALLBACK_QUOTES.length];
    return { text: f.text, author: f.author, source: null, fallback: true };
  }

  function cleanQuoteText(t) {
    return String(t).trim().replace(/^["“”]+|["“”]+$/g, '').trim();
  }

  /* ---------- display formatting ---------- */
  function monthDay(n) { var p = ymdOf(n); return MONTHS_SHORT[p.m0] + ' ' + p.d; }

  function formatDayRange(start, end, todayN) {
    var a = ymdOf(start), b = ymdOf(end), ty = ymdOf(todayN).y;
    var showYear = a.y !== ty || b.y !== ty;
    function f(p, yr) { return MONTHS_SHORT[p.m0] + ' ' + p.d + (yr ? ', ' + p.y : ''); }
    if (start === end) return WEEKDAY_BY_INDEX[weekdayOf(start)] + ', ' + f(a, showYear);
    if (a.y === b.y && a.m0 === b.m0) {
      return MONTHS_SHORT[a.m0] + ' ' + a.d + ' – ' + b.d + (showYear ? ', ' + a.y : '');
    }
    if (a.y === b.y) return f(a, false) + ' – ' + f(b, showYear);
    return f(a, true) + ' – ' + f(b, true);
  }

  function weekLabel(monday, todayN) {
    var fri = monday + 4;
    var a = ymdOf(monday), b = ymdOf(fri);
    var range = a.m0 === b.m0
      ? MONTHS_SHORT[a.m0] + ' ' + a.d + ' – ' + b.d
      : MONTHS_SHORT[a.m0] + ' ' + a.d + ' – ' + MONTHS_SHORT[b.m0] + ' ' + b.d;
    return (monday > todayN ? 'Next week · ' : 'Week of ') + range;
  }

  function longDate(n) {
    var p = ymdOf(n);
    return WEEKDAY_LONG[weekdayOf(n)] + ', ' + MONTHS_TITLE[p.m0] + ' ' + p.d;
  }

  function relativeChip(start, end, todayN, ongoingLabel) {
    if (start <= todayN && todayN <= end) return start === end ? 'Today' : ongoingLabel;
    if (start === todayN + 1) return 'Tomorrow';
    return '';
  }

  function tidy(v) {
    // Display polish only: spaced hyphen between two parts -> en dash.
    return String(v).replace(/\s+-\s+/g, ' – ');
  }

  /* ================================================================== *
   * Browser-only code below
   * ================================================================== */
  var store = {
    schedule: { ok: false, reason: 'loading' },
    timeoff: { ok: false, reason: 'loading' },
    events: { ok: false, reason: 'loading' },
    quote: { ok: false, reason: 'loading' }
  };
  var PARSE = { schedule: parseSchedule, timeoff: parseTimeOff, events: parseEvents, quote: parseQuote };

  var rot = { order: CONFIG.VIEW_ORDER.slice(), idx: 0, timer: null, subTimers: [], speed: 1, frame: 0 };
  var dom = {};

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function viewEl(name) { return document.querySelector('.view[data-view="' + name + '"]'); }

  function setSubtitle(view, text) {
    var s = view.querySelector('[data-subtitle]');
    if (s) s.textContent = text || ' ';
  }

  function newFrame(body, center) {
    var f = el('div', 'frame' + (center ? ' center' : ''));
    var fit = el('div', 'fit');
    f.appendChild(fit);
    body.appendChild(f);
    return { el: f, fit: fit };
  }

  // Does the frame's content fit at text scale f?
  function fitsAt(fr, f) {
    var c = fr.fit;
    c.style.setProperty('--fit', f.toFixed(3));
    if (c.offsetHeight > fr.el.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1) return false;
    // Dates/times that must stay on one line also have to stay inside their card's padding.
    var spans = c.querySelectorAll('.event .nowrap');
    for (var i = 0; i < spans.length; i++) {
      var card = spans[i].closest('.event');
      var limit = card.getBoundingClientRect().right - parseFloat(getComputedStyle(card).paddingRight) + 1;
      if (spans[i].getBoundingClientRect().right > limit) return false;
    }
    return true;
  }

  // Largest --fit in [min, max] at which the content fits its frame (binary search).
  function fitFrame(fr, min, max) {
    function fits(f) { return fitsAt(fr, f); }
    if (fits(max)) return { fit: max, fits: true };
    if (!fits(min)) return { fit: min, fits: false };
    var lo = min, hi = max;
    for (var i = 0; i < 10; i++) {
      var mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid; else hi = mid;
    }
    fits(lo);
    return { fit: lo, fits: true };
  }

  function placeholderNode(msg, inline) {
    var w = el('div', 'placeholder' + (inline ? ' inline' : ''));
    w.appendChild(el('div', 'pulse'));
    w.appendChild(el('p', 'ph-msg', msg));
    if (!inline) {
      w.appendChild(el('p', 'ph-sub', 'Checking again every ' + Math.round(CONFIG.REFRESH_MS / 60000) + ' minutes'));
    }
    return w;
  }

  function renderPlaceholder(view, msg) {
    var body = view.querySelector('.view-body');
    body.textContent = '';
    var fr = newFrame(body, true);
    fr.fit.appendChild(placeholderNode(msg));
    fitFrame(fr, CONFIG.FIT.FLOOR, CONFIG.FIT.MAX);
    return 1;
  }

  /* ---------- View 1: Schedule ---------- */
  function daysNode(week) {
    var wrap = el('div', 'days');
    week.forEach(function (day) {
      var d = el('div', 'day' + (day.isToday ? ' is-today' : '') + (day.isPast ? ' is-past' : ''));
      var lab = el('div', 'day-label');
      lab.appendChild(el('span', 'dow', DAY_SHORT[day.key]));
      lab.appendChild(el('span', 'dom', monthDay(day.date)));
      if (day.isToday) lab.appendChild(el('span', 'chip', 'Today'));
      var rows = el('div', 'rows');
      if (!day.rows.length) rows.appendChild(el('div', 'row-empty', 'No one scheduled'));
      day.rows.forEach(function (r) {
        var row = el('div', 'row');
        row.appendChild(el('span', 'name', r.name));
        row.appendChild(el('span', 'val val-' + r.kind, r.text));
        rows.appendChild(row);
      });
      d.appendChild(lab);
      d.appendChild(rows);
      wrap.appendChild(d);
    });
    return wrap;
  }

  function timeOffNode(model, todayN) {
    var sec = el('section', 'timeoff');
    sec.appendChild(el('h2', 'section-title', 'Time Off'));
    if (!model) {
      sec.appendChild(placeholderNode('Time off unavailable — retrying…', true));
      return sec;
    }
    if (!model.upcoming.length) {
      sec.appendChild(el('p', 'empty', 'No upcoming time off'));
      return sec;
    }
    model.upcoming.forEach(function (e) {
      var row = el('div', 'to-row');
      row.appendChild(el('span', 'name', e.name));
      var when = el('span', 'when', formatDayRange(e.start, e.end, todayN));
      if (e.note) when.appendChild(el('span', 'note', ' · ' + e.note));
      row.appendChild(when);
      var chip = relativeChip(e.start, e.end, todayN, 'Out now');
      row.appendChild(chip ? el('span', 'chip', chip === 'Today' ? 'Out today' : chip) : el('span', ''));
      sec.appendChild(row);
    });
    if (model.more > 0) sec.appendChild(el('div', 'to-more', '+ ' + model.more + ' more'));
    return sec;
  }

  function renderSchedule(view) {
    var today = todayNum();
    var monday = weekMonday(today);
    setSubtitle(view, weekLabel(monday, today));
    if (!store.schedule.ok) return renderPlaceholder(view, 'Schedule unavailable — retrying…');

    var toModel = null;
    if (store.timeoff.ok) {
      try { toModel = resolveTimeOff(store.timeoff.data, today); } catch (e) { console.warn(e.message); }
    }
    var week = buildWeek(store.schedule.data, toModel ? toModel.all : [], today);

    var body = view.querySelector('.view-body');
    body.textContent = '';

    // 1) Try everything in one frame, shrinking no further than READABLE_MIN.
    var f0 = newFrame(body, false);
    f0.fit.appendChild(daysNode(week));
    var toNode = timeOffNode(toModel, today);
    f0.fit.appendChild(toNode);
    if (fitFrame(f0, CONFIG.FIT.READABLE_MIN, CONFIG.FIT.MAX).fits) return 1;

    // 2) Split: day list, then Time Off, each fitted on its own.
    f0.fit.removeChild(toNode);
    fitFrame(f0, CONFIG.FIT.FLOOR, CONFIG.FIT.MAX);
    var f1 = newFrame(body, false);
    f1.fit.appendChild(toNode);
    fitFrame(f1, CONFIG.FIT.FLOOR, CONFIG.FIT.MAX);
    return 2;
  }

  /* ---------- View 2: Upcoming Events ---------- */
  function renderEvents(view) {
    var today = todayNum();
    if (!store.events.ok) {
      setSubtitle(view, '');
      return renderPlaceholder(view, 'Events unavailable — retrying…');
    }
    var items;
    try { items = resolveEvents(store.events.data, today); } catch (e) {
      console.warn(e.message);
      setSubtitle(view, '');
      return renderPlaceholder(view, 'Events unavailable — retrying…');
    }
    var label = items.length > 1 ? 'Next ' + items.length + ' events'
      : items.length === 1 ? 'Next event' : 'Nothing on the calendar';
    setSubtitle(view, label);

    var body = view.querySelector('.view-body');
    body.textContent = '';
    if (!items.length) {
      var fe = newFrame(body, true);
      var empty = el('div', 'placeholder');
      empty.appendChild(el('p', 'ph-msg', 'No upcoming events'));
      empty.appendChild(el('p', 'ph-sub', 'Check back soon'));
      fe.fit.appendChild(empty);
      fitFrame(fe, CONFIG.FIT.FLOOR, CONFIG.FIT.MAX);
      return 1;
    }

    var pages = layoutEvents(body, items, today);
    if (pages.length > 1) {
      view._subtitles = pages.map(function (_, i) { return label + ' · ' + (i + 1) + '/' + pages.length; });
      setSubtitle(view, view._subtitles[0]);
    }
    return pages.length;
  }

  // One event card, in one of three layouts:
  //   'stacked' - label above each value (roomy; best for 1-2 events)
  //   'grid'    - label and value side by side
  //   'compact' - dates and time on one line (best when many events share the screen)
  function eventCard(x, today, layout) {
    var card = el('article', 'event ' + layout);
    var title = el('h2', 'event-title', x.ev.title);
    var chip = relativeChip(x.start, x.end, today, 'Happening now');
    if (chip) title.appendChild(el('span', 'chip', chip));
    card.appendChild(title);
    var WHEN_KEY = /^(dates?|timings?|times?)$/i;   // these never break mid-value
    if (layout !== 'compact') {
      x.ev.fields.forEach(function (f) {
        var row = el('div', 'field');
        row.appendChild(el('span', 'field-key', /^timings?$/i.test(f.key) ? 'Time' : f.key));
        row.appendChild(el('span', 'field-val' + (WHEN_KEY.test(f.key) ? ' nowrap' : ''), tidy(f.value)));
        card.appendChild(row);
      });
      return card;
    }
    var when = [];
    var rest = [];
    x.ev.fields.forEach(function (f) {
      if (WHEN_KEY.test(f.key)) when.push(tidy(f.value)); else rest.push(f);
    });
    if (when.length) {
      var line = el('div', 'event-when');
      when.forEach(function (w, i) {
        if (i) line.appendChild(el('span', 'sep', ' · '));
        line.appendChild(el('span', 'nowrap', w));
      });
      card.appendChild(line);
    }
    rest.forEach(function (f) {
      var meta = el('div', 'event-meta');
      meta.appendChild(el('span', 'field-key', f.key));
      meta.appendChild(el('span', 'field-val', tidy(f.value)));
      card.appendChild(meta);
    });
    return card;
  }

  // Cards resize to the space available. All events on one screen in whichever
  // layout gives the largest text; if even the best is below READABLE_MIN, compact
  // cards are spread evenly over pages that each fit at a readable size.
  function layoutEvents(body, items, today) {
    var R = CONFIG.FIT.READABLE_MIN, F = CONFIG.FIT.FLOOR, M = CONFIG.FIT.MAX;

    function onePage(list, layout) {
      var fr = newFrame(body, true);
      list.forEach(function (x) { fr.fit.appendChild(eventCard(x, today, layout)); });
      return fr;
    }

    var layouts = ['stacked', 'grid', 'compact'];
    var best = null;
    layouts.forEach(function (layout) {
      body.textContent = '';
      var r = fitFrame(onePage(items, layout), F, M);
      // Prefer the roomier layout unless another one gives clearly bigger text.
      if (r.fits && (!best || r.fit > best.fit * 1.04)) best = { layout: layout, fit: r.fit };
    });
    if (best && best.fit >= R) {
      body.textContent = '';
      var single = onePage(items, best.layout);
      fitFrame(single, F, M);
      return [single];
    }

    // How many pages does a greedy fill need?
    body.textContent = '';
    var count = 1;
    var probe = newFrame(body, true);
    items.forEach(function (x) {
      var card = eventCard(x, today, 'compact');
      probe.fit.appendChild(card);
      if (probe.fit.children.length > 1 && !fitsAt(probe, R)) {
        count++;
        probe.fit.textContent = '';
        probe.fit.appendChild(card);
      }
    });

    // Spread the events evenly over that many pages (add a page if a chunk is too tall).
    var pages;
    for (var n = count; n <= items.length; n++) {
      body.textContent = '';
      pages = [];
      var per = Math.ceil(items.length / n);
      for (var i = 0; i < items.length; i += per) pages.push(onePage(items.slice(i, i + per), 'compact'));
      if (pages.every(function (p) { return fitsAt(p, R) || p.fit.children.length === 1; })) break;
    }

    // Same text size on every page: the largest size all of them can take.
    var size = M;
    pages.forEach(function (p) { size = Math.min(size, fitFrame(p, F, M).fit); });
    pages.forEach(function (p) { p.fit.style.setProperty('--fit', size.toFixed(3)); });
    return pages;
  }

  /* ---------- View 3: Quote of the Day ---------- */
  function renderQuote(view) {
    var today = todayNum();
    setSubtitle(view, longDate(today));
    var q = pickQuote(store.quote, today);
    var body = view.querySelector('.view-body');
    body.textContent = '';
    var fr = newFrame(body, true);
    var card = el('figure', 'quote-card');
    card.style.margin = '0';
    card.appendChild(el('div', 'qmark', '“'));
    card.appendChild(el('blockquote', 'qtext', q.text));
    card.appendChild(el('figcaption', 'qauthor', '— ' + q.author));
    if (q.source) card.appendChild(el('p', 'qsource', 'via ' + q.source));
    fr.fit.appendChild(card);
    fitFrame(fr, CONFIG.FIT.FLOOR, CONFIG.FIT.QUOTE_MAX);
    return 1;
  }

  var RENDER = { schedule: renderSchedule, events: renderEvents, quote: renderQuote };
  var FAIL_MSG = {
    schedule: 'Schedule unavailable — retrying…',
    events: 'Events unavailable — retrying…',
    quote: 'Quote unavailable — retrying…'
  };

  // A view that throws never stops the rotation: it shows its placeholder instead.
  function safeRender(name, view) {
    view._subtitles = null;
    try { return RENDER[name](view); } catch (e) {
      console.error('[signage] render ' + name + ' failed:', e);
      try { return renderPlaceholder(view, FAIL_MSG[name]); } catch (e2) { return 1; }
    }
  }

  /* ---------- Rotation ---------- */
  function setFrame(view, idx) {
    var frames = view.querySelectorAll('.frame');
    for (var i = 0; i < frames.length; i++) frames[i].classList.toggle('active', i === idx);
    if (view._subtitles && view._subtitles[idx]) setSubtitle(view, view._subtitles[idx]);
    rot.frame = idx;
  }

  // How long each frame of a view stays up.
  function frameDurations(name, frames) {
    var base = CONFIG.VIEW_DURATION_MS[name];
    if (frames <= 1) return [base];
    if (name === 'schedule') {
      return [base * CONFIG.SCHEDULE_SPLIT_RATIO, base * (1 - CONFIG.SCHEDULE_SPLIT_RATIO)];
    }
    var out = [];
    for (var i = 0; i < frames; i++) out.push(Math.max(CONFIG.EVENTS_PAGE_MS, base / frames));
    return out;
  }

  function clearRotationTimers() {
    clearTimeout(rot.timer);
    rot.subTimers.forEach(clearTimeout);
    rot.subTimers = [];
  }

  function updateDots(name) {
    var dots = dom.dots.querySelectorAll('.dot');
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('active', dots[i].getAttribute('data-for') === name);
  }

  function show(idx) {
    clearRotationTimers();
    rot.idx = idx;
    var name = rot.order[idx];
    var view = viewEl(name);
    var frames = safeRender(name, view);
    setFrame(view, 0);
    var all = document.querySelectorAll('.view');
    for (var i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i] === view);
    updateDots(name);

    var durs = frameDurations(name, frames).map(function (d) { return d / rot.speed; });
    var t = 0;
    durs.forEach(function (d, k) {
      if (k > 0) rot.subTimers.push(setTimeout(function () { setFrame(view, k); }, t));
      t += d;
    });
    rot.timer = setTimeout(function () { show((idx + 1) % rot.order.length); }, t);
  }

  function stopRotation() {
    clearRotationTimers();
    var all = document.querySelectorAll('.view');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
  }

  /* ---------- Office hours: rotation vs. idle clock ---------- */
  var mode = { current: null, forced: null, ready: false };

  function wantedMode() {
    return mode.forced || (officeOpen(phoenixParts()) ? 'active' : 'idle');
  }

  function applyMode() {
    var want = wantedMode();
    document.body.classList.toggle('is-idle', want === 'idle');
    if (!mode.ready || want === mode.current) return;
    mode.current = want;
    if (want === 'active') show(0); else stopRotation();
  }

  function driftIdleClock() {
    if (!dom.idleInner) return;
    var x = (Math.random() * 2 - 1) * 10;   // vw
    var y = (Math.random() * 2 - 1) * 16;   // vh
    dom.idleInner.style.transform = 'translate(' + x.toFixed(1) + 'vw,' + y.toFixed(1) + 'vh)';
  }

  function rerenderActive() {
    var name = rot.order[rot.idx];
    var view = viewEl(name);
    var frames = safeRender(name, view);
    setFrame(view, Math.min(rot.frame, frames - 1));
  }

  /* ---------- Data refresh ---------- */
  function fetchText(url) {
    var full = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer;
    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        var e = new Error('timeout'); e.kind = 'network'; reject(e);
      }, CONFIG.FETCH_TIMEOUT_MS);
    });
    var req = fetch(full, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
      if (!res.ok) { var e = new Error('HTTP ' + res.status); e.kind = 'http'; throw e; }
      return res.text();
    }, function (err) {
      var e = new Error(String(err && err.message || err)); e.kind = 'network'; throw e;
    });
    return Promise.race([req, timeout]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  function refreshOne(key) {
    return fetchText(CONFIG.DATA_FILES[key]).then(function (txt) {
      try {
        store[key] = { ok: true, data: PARSE[key](txt), at: Date.now() };
      } catch (e) {
        console.warn('[signage] ' + key + ' parse failed:', e.message);
        store[key] = { ok: false, reason: 'parse' };
      }
    }, function (err) {
      var prev = store[key];
      // A network blip keeps the last good copy on screen; a real HTTP error
      // (e.g. 404 because the file was deleted) shows the placeholder.
      if (err.kind === 'network' && prev && prev.ok) { prev.stale = true; return; }
      console.warn('[signage] ' + key + ' fetch failed:', err.message);
      store[key] = { ok: false, reason: err.kind || 'network' };
    });
  }

  function refreshAll() {
    return Promise.all(Object.keys(CONFIG.DATA_FILES).map(refreshOne));
  }

  /* ---------- Clock ---------- */
  var clockFmt = null;
  function tickClock() {
    if (!clockFmt) {
      clockFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: CONFIG.TIMEZONE, hour: 'numeric', minute: '2-digit', hour12: true
      });
    }
    var now = new Date();

    // "4:07" + "PM" for both the corner clock and the idle clock.
    var hm = '', ap = '';
    clockFmt.formatToParts(now).forEach(function (p) {
      if (p.type === 'hour') hm = p.value + hm;
      else if (p.type === 'minute') hm = hm + ':' + p.value;
      else if (p.type === 'dayPeriod') ap = p.value;
    });
    if (dom.clockHm.textContent !== hm) dom.clockHm.textContent = hm;
    if (dom.clockAp.textContent !== ap) dom.clockAp.textContent = ap;
    if (dom.idleTime.textContent !== hm) dom.idleTime.textContent = hm;
    if (dom.idleAmpm.textContent !== ap) dom.idleAmpm.textContent = ap;
    var d = longDate(todayNum());
    if (dom.idleDate.textContent !== d) dom.idleDate.textContent = d;

    // Switch between rotation and idle clock when office hours start or end.
    applyMode();

    setTimeout(tickClock, 1000 - (Date.now() % 1000) + 20);
  }

  /* ---------- Daily reload (2:00 AM Phoenix) ---------- */
  function msUntilHour(hour) {
    var p = phoenixParts();
    var now = p.h * 3600 + p.mi * 60 + p.s;
    var delta = hour * 3600 - now;
    if (delta <= 0) delta += 86400;
    return delta * 1000;
  }

  function scheduleDailyReload() {
    var reloadAt = Date.now() + msUntilHour(CONFIG.RELOAD_HOUR);
    setInterval(function () {
      if (Date.now() < reloadAt) return;
      // Only reload if the site is reachable, otherwise a network outage at
      // 2 AM would leave the screen on a browser error page.
      reloadAt = Date.now() + CONFIG.RELOAD_RETRY_MS;
      fetch('index.html?_=' + Date.now(), { cache: 'no-store' }).then(function (res) {
        if (res.ok) root.location.reload();
      }, function () { /* retry later */ });
    }, 30000);
  }

  /* ---------- Screen care ---------- */
  function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    function req() { navigator.wakeLock.request('screen').catch(function () { }); }
    req();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') req();
    });
  }

  // Triangle wave in [-1, 1]: moves at constant speed, so every position gets equal time.
  function tri(t) { var f = t - Math.floor(t); return f < 0.5 ? 4 * f - 1 : 3 - 4 * f; }

  function oledOrbit() {
    var O = CONFIG.OLED_ORBIT;
    if (!O || !O.STEP_MS) return;
    function step() {
      var min = Date.now() / 60000;
      // Two unrelated periods (37 and 23 minutes) trace a path that fills the whole box.
      // Whole-pixel steps: fractional offsets leave a faint seam at the screen edge.
      var x = Math.round(tri(min / 37) * O.X_VW / 100 * root.innerWidth);
      var y = Math.round(tri(min / 23) * O.Y_VH / 100 * root.innerHeight);
      dom.stage.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    }
    step();
    setInterval(step, O.STEP_MS);
  }

  // The page background shows in the sliver the drifting screen uncovers:
  // maroon beside the header, dark below it (see body background in style.css).
  function syncHeaderHeight() {
    var h = document.querySelector('.view-header');
    if (h) document.documentElement.style.setProperty('--hdr', h.offsetHeight + 'px');
  }

  /* ---------- Boot ---------- */
  function readDebugParams() {
    var q = {};
    String(root.location.search || '').replace(/^\?/, '').split('&').forEach(function (kv) {
      if (!kv) return;
      var p = kv.split('=');
      q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
    });
    if (q.view && CONFIG.VIEW_ORDER.indexOf(q.view) >= 0) rot.order = [q.view];
    if (q.date) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(q.date);
      if (m) debugToday = dayNum(+m[1], +m[2] - 1, +m[3]);
    }
    if (q.speed && +q.speed > 0) rot.speed = +q.speed;
    if (q.mode === 'active' || q.mode === 'idle') mode.forced = q.mode;
  }

  function boot() {
    dom.stage = document.getElementById('stage');
    dom.clock = document.getElementById('clock');
    dom.clockHm = document.getElementById('clock-hm');
    dom.clockAp = document.getElementById('clock-ap');
    dom.dots = document.getElementById('dots');
    dom.idleInner = document.getElementById('idle-inner');
    dom.idleTime = document.getElementById('idle-time');
    dom.idleAmpm = document.getElementById('idle-ampm');
    dom.idleDate = document.getElementById('idle-date');
    document.documentElement.style.setProperty('--fade', CONFIG.FADE_MS + 'ms');
    readDebugParams();

    CONFIG.VIEW_ORDER.forEach(function (name) {
      var d = el('span', 'dot');
      d.setAttribute('data-for', name);
      dom.dots.appendChild(d);
    });

    tickClock();          // also shows the idle clock right away outside office hours
    keepAwake();
    oledOrbit();
    syncHeaderHeight();
    scheduleDailyReload();
    if (CONFIG.IDLE_DRIFT_MS) setInterval(driftIdleClock, CONFIG.IDLE_DRIFT_MS);

    function start() {
      if (mode.ready) return;
      mode.ready = true;
      applyMode();
    }
    refreshAll().then(start, start);
    setTimeout(start, CONFIG.FETCH_TIMEOUT_MS + 2000); // never wait forever for the first load
    setInterval(refreshAll, CONFIG.REFRESH_MS);

    var resizeTimer;
    root.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        syncHeaderHeight();
        if (mode.current === 'active') rerenderActive();
      }, 300);
    });
  }

  /* ---------- Exports (Node tests) / start (browser) ---------- */
  var API = {
    CONFIG: CONFIG, FALLBACK_QUOTES: FALLBACK_QUOTES,
    dayNum: dayNum, ymdOf: ymdOf, weekdayOf: weekdayOf, weekMonday: weekMonday,
    parseDatePart: parseDatePart, parseDateRange: parseDateRange,
    parseSchedule: parseSchedule, parseTimeOff: parseTimeOff, parseEvents: parseEvents, parseQuote: parseQuote,
    classifyValue: classifyValue, buildWeek: buildWeek, resolveTimeOff: resolveTimeOff,
    resolveEvents: resolveEvents, pickQuote: pickQuote, formatDayRange: formatDayRange, weekLabel: weekLabel,
    officeOpen: officeOpen,
    refreshNow: refreshAll   // e.g. Signage.refreshNow() from the browser console
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof document !== 'undefined' && root && root.location) {
    root.Signage = API;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})(typeof window !== 'undefined' ? window : this);
