from __future__ import annotations
import json
import re
import requests
from bs4 import BeautifulSoup
from typing import List, Dict

# Optional: use newspaper3k if available
try:
    from newspaper import Article  # type: ignore
    _HAS_NEWSPAPER = True
except Exception:
    _HAS_NEWSPAPER = False

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
}

class ArticleScraper:
    def scrape(self, urls: List[str]) -> List[Dict[str, str]]:
        results: List[Dict[str, str]] = []
        for url in urls:
            try:
                if _HAS_NEWSPAPER:
                    art = Article(url)
                    art.download()
                    art.parse()
                    title = art.title or url
                    content = art.text
                else:
                    resp = requests.get(url, headers=HEADERS, timeout=15)
                    resp.raise_for_status()
                    soup = BeautifulSoup(resp.text, "html.parser")
                    title = (soup.title.string.strip() if soup.title and soup.title.string else url)
                    # Try <article> first, else collect paragraphs
                    article_tag = soup.find("article")
                    if article_tag:
                        paragraphs = [p.get_text(strip=True) for p in article_tag.find_all("p")]
                    else:
                        paragraphs = [p.get_text(strip=True) for p in soup.find_all("p")]
                    content = "\n\n".join([p for p in paragraphs if p])
                results.append({"url": url, "title": title, "content": content})
            except Exception as e:
                results.append({"url": url, "title": url, "content": f"[Error scraping] {e}"})
        return results

    def find_videos(self, urls: List[str]) -> List[Dict[str, str]]:
        """Extract likely video media from a list of article pages.

        Returns a list of dicts with keys:
          - title
          - pageUrl
          - sourceType: youtube|vimeo|mp4|webm|m3u8|embed|other
          - srcUrl: direct media or embeddable url
          - poster: optional
          - duration: optional (ISO 8601 or seconds if available)
        """
        videos: List[Dict[str, str]] = []
        seen = set()

        yt_re = re.compile(r"(?:youtube\.com/watch\?v=|youtu\.be/)([A-Za-z0-9_-]{6,})")
        vimeo_re = re.compile(r"vimeo\.com/(?:video/)?(\d+)")

        def add_item(item: Dict[str, str]):
            key = (item.get("sourceType"), item.get("srcUrl"))
            if not key[1] or key in seen:
                return
            seen.add(key)
            videos.append(item)

        for url in urls:
            try:
                # If the URL itself is a media URL, add directly
                if url.endswith(('.mp4', '.webm')) or '.m3u8' in url:
                    stype = 'mp4' if url.endswith('.mp4') else ('webm' if url.endswith('.webm') else 'm3u8')
                    add_item({
                        "title": url,
                        "pageUrl": url,
                        "sourceType": stype,
                        "srcUrl": url,
                        "poster": "",
                        "duration": ""
                    })
                    continue
                resp = requests.get(url, headers=HEADERS, timeout=15)
                resp.raise_for_status()
                html = resp.text
                soup = BeautifulSoup(html, "html.parser")
                page_title = (soup.title.string.strip() if soup.title and soup.title.string else url)

                # 1) JSON-LD VideoObject
                for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
                    try:
                        data = json.loads(script.string or "{}")
                    except Exception:
                        continue
                    def handle_obj(obj):
                        if not isinstance(obj, dict):
                            return
                        t = obj.get("@type") or obj.get("type")
                        if isinstance(t, list):
                            t = ",".join(t)
                        if t and "VideoObject" in str(t):
                            src = obj.get("contentUrl") or obj.get("embedUrl") or obj.get("url")
                            poster = obj.get("thumbnailUrl") or obj.get("thumbnail")
                            duration = obj.get("duration")
                            if src:
                                stype = "other"
                                if ".m3u8" in src:
                                    stype = "m3u8"
                                elif src.endswith(('.mp4', '.webm')):
                                    stype = 'mp4' if src.endswith('.mp4') else 'webm'
                                add_item({
                                    "title": obj.get("name") or page_title,
                                    "pageUrl": url,
                                    "sourceType": stype,
                                    "srcUrl": src,
                                    "poster": poster or "",
                                    "duration": duration or ""
                                })
                        # nested
                        for k, v in obj.items():
                            if isinstance(v, dict):
                                handle_obj(v)
                            elif isinstance(v, list):
                                for it in v:
                                    if isinstance(it, dict):
                                        handle_obj(it)
                    if isinstance(data, list):
                        for obj in data:
                            handle_obj(obj)
                    elif isinstance(data, dict):
                        handle_obj(data)

                # 2) OpenGraph/Twitter video
                og_props = [
                    ("property", "og:video"),
                    ("property", "og:video:url"),
                    ("property", "og:video:secure_url"),
                    ("name", "og:video"),
                ]
                for attr, val in og_props:
                    tag = soup.find("meta", attrs={attr: val})
                    if tag and tag.get("content"):
                        src = tag.get("content")
                        stype = "other"
                        if ".m3u8" in src:
                            stype = "m3u8"
                        elif src.endswith(('.mp4', '.webm')):
                            stype = 'mp4' if src.endswith('.mp4') else 'webm'
                        add_item({
                            "title": page_title,
                            "pageUrl": url,
                            "sourceType": stype,
                            "srcUrl": src,
                            "poster": "",
                            "duration": ""
                        })

                tw_player = soup.find("meta", attrs={"name": "twitter:player"}) or soup.find("meta", attrs={"property": "twitter:player"})
                if tw_player and tw_player.get("content"):
                    src = tw_player.get("content")
                    add_item({
                        "title": page_title,
                        "pageUrl": url,
                        "sourceType": "embed",
                        "srcUrl": src,
                        "poster": "",
                        "duration": ""
                    })

                # 3) <video> and <source>
                for vtag in soup.find_all("video"):
                    poster = vtag.get("poster") or ""
                    if vtag.get("src"):
                        src = vtag.get("src")
                        stype = 'mp4' if src.endswith('.mp4') else ('webm' if src.endswith('.webm') else ('m3u8' if '.m3u8' in src else 'other'))
                        add_item({
                            "title": page_title,
                            "pageUrl": url,
                            "sourceType": stype,
                            "srcUrl": src,
                            "poster": poster,
                            "duration": ""
                        })
                    for st in vtag.find_all("source"):
                        src = st.get("src")
                        if not src:
                            continue
                        stype = 'mp4' if src.endswith('.mp4') else ('webm' if src.endswith('.webm') else ('m3u8' if '.m3u8' in src else 'other'))
                        add_item({
                            "title": page_title,
                            "pageUrl": url,
                            "sourceType": stype,
                            "srcUrl": src,
                            "poster": poster,
                            "duration": ""
                        })

                # 4) iframes to youtube/vimeo
                for iframe in soup.find_all("iframe"):
                    src = iframe.get("src") or ""
                    if not src:
                        continue
                    m = yt_re.search(src)
                    if m:
                        vid = m.group(1)
                        embed = f"https://www.youtube-nocookie.com/embed/{vid}"
                        add_item({
                            "title": page_title,
                            "pageUrl": url,
                            "sourceType": "youtube",
                            "srcUrl": embed,
                            "poster": "",
                            "duration": ""
                        })
                        continue
                    m = vimeo_re.search(src)
                    if m:
                        vid = m.group(1)
                        embed = f"https://player.vimeo.com/video/{vid}"
                        add_item({
                            "title": page_title,
                            "pageUrl": url,
                            "sourceType": "vimeo",
                            "srcUrl": embed,
                            "poster": "",
                            "duration": ""
                        })

                # 5) direct links within anchors
                for a in soup.find_all('a', href=True):
                    href = a['href']
                    if href.endswith(('.mp4', '.webm')) or '.m3u8' in href:
                        stype = 'mp4' if href.endswith('.mp4') else ('webm' if href.endswith('.webm') else 'm3u8')
                        add_item({
                            "title": page_title,
                            "pageUrl": url,
                            "sourceType": stype,
                            "srcUrl": href,
                            "poster": "",
                            "duration": ""
                        })
                
                # 6) look for youtube/vimeo links
                for a in soup.find_all('a', href=True):
                    href = a['href']
                    m = yt_re.search(href)
                    if m:
                        vid = m.group(1)
                        embed = f"https://www.youtube-nocookie.com/embed/{vid}"
                        add_item({
                            "title": page_title,
                            "pageUrl": url,
                            "sourceType": "youtube",
                            "srcUrl": embed,
                            "poster": "",
                            "duration": ""
                        })
                    m = vimeo_re.search(href)
                    if m:
                        vid = m.group(1)
                        embed = f"https://player.vimeo.com/video/{vid}"
                        add_item({
                            "title": page_title,
                            "pageUrl": url,
                            "sourceType": "vimeo",
                            "srcUrl": embed,
                            "poster": "",
                            "duration": ""
                        })

            except Exception:
                # Skip on error; continue with others
                continue

        return videos
