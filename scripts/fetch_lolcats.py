#!/usr/bin/env python3
"""Collect LOLcat meme image links from I Can Has Cheezburger? into data/lolcats.json.

The site has no feed: https://icanhas.cheezburger.com/lolcats lists articles, and each
article ("Your Weekly Binge of LOLcat Cuteness...", "Caturday LOLcat Clawmedy...") holds
dozens of single memes on i.chzbgr.com. This keeps the image *links* (newest articles
first) plus a credit link; no images are copied into the repo.

Usage: fetch_lolcats.py [out.json]       (exit 1 = nothing usable found; old file kept)
"""
import html, json, re, sys, time, urllib.request
from datetime import datetime, timezone

LISTING = "https://icanhas.cheezburger.com/lolcats"
MAX_ARTICLES = 6
MAX_ITEMS = 400
MIN_ITEMS = 10
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0 Safari/537.36")

ARTICLE_RE = re.compile(r'https://cheezburger\.com/(\d+)/([a-z0-9][a-z0-9\-]*)')
IMAGE_RE = re.compile(r'https://i\.chzbgr\.com/full/(\d+)/(h[0-9A-Fa-f]+)/([A-Za-z0-9\-_.%]*)')


def get(url, referer=None):
    headers = {"User-Agent": UA, "Accept": "text/html,image/*;q=0.9,*/*;q=0.8"}
    if referer:
        headers["Referer"] = referer
    err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=25) as r:
                return r.status, r.headers.get("Content-Type", ""), r.read()
        except Exception as e:  # noqa: BLE001
            err = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"{url}: {err}")


def articles_in(listing_html):
    """Article links on the listing page, in page order (newest first), deduplicated."""
    seen, out = set(), []
    for m in ARTICLE_RE.finditer(listing_html):
        aid, slug = m.group(1), m.group(2)
        if aid in seen:
            continue
        seen.add(aid)
        out.append(f"https://cheezburger.com/{aid}/{slug}")
    return out


def memes_in(article_html, article_url):
    """Single meme images in an article (the /full/ ones), in page order, deduplicated."""
    seen, out = set(), []
    for m in IMAGE_RE.finditer(html.unescape(article_html)):
        img_id = m.group(1)
        if img_id in seen:
            continue
        seen.add(img_id)
        slug = m.group(3)
        alt = re.sub(r"-?icanhascheezburger(com)?", "", slug).replace("-", " ").strip()
        out.append({"url": m.group(0), "alt": alt[:160], "from": article_url})
    return out


def main(out_path):
    status, _, body = get(LISTING)
    arts = articles_in(body.decode("utf-8", "replace"))[:MAX_ARTICLES]
    print(f"{len(arts)} articles on {LISTING}")
    items, seen = [], set()
    for a in arts:
        try:
            _, _, page = get(a)
        except RuntimeError as e:
            print(f"::warning::{e}")
            continue
        found = memes_in(page.decode("utf-8", "replace"), a)
        print(f"  {len(found):3d} memes  {a}")
        for it in found:
            if it["url"] not in seen:
                seen.add(it["url"])
                items.append(it)
    items = items[:MAX_ITEMS]
    if len(items) < MIN_ITEMS:
        print(f"::error::Only {len(items)} memes found; keeping the old list")
        return 1

    # The screen links straight to i.chzbgr.com from the GitHub Pages site: make sure
    # an image loads with that kind of request (no hotlink block).
    try:
        st, ctype, _ = get(items[0]["url"], referer="https://vigneshn10.github.io/office-signage/")
        print(f"Image check: HTTP {st}, {ctype}")
        if not ctype.startswith("image/"):
            print("::warning::i.chzbgr.com did not return an image; the screen will fall back to TheCatAPI")
    except RuntimeError as e:
        print(f"::warning::Image check failed: {e}")

    data = {
        "source": "I Can Has Cheezburger?",
        "sourceUrl": LISTING,
        "updated": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "items": items,
    }
    try:
        with open(out_path, encoding="utf-8") as f:
            if json.load(f).get("items") == items:
                print("No new memes.")
                return 0
    except Exception:  # noqa: BLE001
        pass
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"Wrote {len(items)} memes to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "data/lolcats.json"))
