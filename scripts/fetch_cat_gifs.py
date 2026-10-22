#!/usr/bin/env python3
"""Collect cat GIF links from a Tenor search page into data/catgifs.json.

https://tenor.com/en-GB/search/cat-gifs lists ~50 results as links to view pages
(tenor.com/.../view/<slug>-gif-<id>); each view page names its GIF in og:image
(media1.tenor.com/m/<id>/<name>.gif). This saves those links (no GIFs are copied)
plus a link back to each Tenor page.

Usage: fetch_cat_gifs.py [out.json]      (exit 1 = too few found; old file kept)
"""
import html, json, re, sys, time, urllib.request
from datetime import datetime, timezone

SEARCH = "https://tenor.com/en-GB/search/cat-gifs"
MAX_ITEMS = 60
MIN_ITEMS = 10
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36")

VIEW_RE = re.compile(r'(?:https://tenor\.com)?/(?:[a-z]{2}(?:-[A-Z]{2})?/)?view/([a-z0-9][a-z0-9\-]*-gif-\d+)')
OG_IMAGE_RE = re.compile(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"|<meta[^>]+content="([^"]+)"[^>]+property="og:image"')
GIF_RE = re.compile(r'^https://media\d*\.tenor\.com/[A-Za-z0-9/_\-.]+\.gif$')


def get(url):
    err = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,*/*;q=0.8"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"{url}: {err}")


def views_in(search_html):
    """Result view-page links in page order, deduplicated."""
    seen, out = set(), []
    for m in VIEW_RE.finditer(search_html):
        slug = m.group(1)
        if slug not in seen:
            seen.add(slug)
            out.append(f"https://tenor.com/view/{slug}")
    return out


def gif_in(view_html):
    m = OG_IMAGE_RE.search(view_html)
    url = html.unescape((m.group(1) or m.group(2)) if m else "")
    return url if GIF_RE.match(url) else None


def main(out_path):
    views = views_in(get(SEARCH))[:MAX_ITEMS]
    print(f"{len(views)} results on {SEARCH}")
    items = []
    for v in views:
        try:
            g = gif_in(get(v))
        except RuntimeError as e:
            print(f"::warning::{e}")
            continue
        if g and all(i["url"] != g for i in items):
            alt = re.sub(r"-gif-\d+$", "", v.rsplit("/", 1)[1]).replace("-", " ")
            items.append({"url": g, "alt": alt[:120], "from": v})
        time.sleep(0.3)
    print(f"{len(items)} GIFs")
    if len(items) < MIN_ITEMS:
        print(f"::error::Only {len(items)} GIFs found; keeping the old list")
        return 1
    data = {
        "source": "Tenor",
        "sourceUrl": SEARCH,
        "updated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "items": items,
    }
    try:
        with open(out_path, encoding="utf-8") as f:
            if json.load(f).get("items") == items:
                print("No new GIFs.")
                return 0
    except Exception:  # noqa: BLE001
        pass
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "data/catgifs.json"))
