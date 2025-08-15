from __future__ import annotations
import os
import json
import requests
import threading
import time
from datetime import datetime
from typing import List, Dict

from flask import Flask, jsonify, request, send_from_directory, Response, stream_with_context
import feedparser

from . import config
from .rss_manager import RSSManager
from .article_scraper import ArticleScraper
from .llm_agent import LLMAgent

# Flask app serving the frontend from ../frontend
app = Flask(
    __name__,
    static_folder=config.FRONTEND_DIR,
    static_url_path="/"
)

rss_manager = RSSManager()
article_scraper = ArticleScraper()
llm = LLMAgent()

# TTS
try:
    import pyttsx3
    _tts_engine = pyttsx3.init()
except Exception:
    _tts_engine = None

@app.get("/")
def index():
    return send_from_directory(config.FRONTEND_DIR, "index.html")

@app.get("/api/feed-groups")
def api_feed_groups():
    return jsonify({"groups": rss_manager.list_groups()})

@app.get("/api/models")
def api_models():
    """List available Ollama models and the default one from config."""
    base = config.OLLAMA_BASE_URL.rstrip("/")
    models = []
    try:
        # Ollama tags endpoint returns installed models
        r = requests.get(f"{base}/api/tags", timeout=10)
        r.raise_for_status()
        data = r.json()
        # Expected shape: {"models": [{"name": "llama3:8b", ...}, ...]}
        if isinstance(data, dict) and isinstance(data.get("models"), list):
            models = [m.get("name") for m in data.get("models", []) if isinstance(m, dict) and m.get("name")]
    except Exception:
        # Fallback to at least expose the configured model
        models = []
    # Ensure configured default is present
    default_model = getattr(config, "OLLAMA_MODEL", None)
    if default_model and default_model not in models:
        models.insert(0, default_model)
    return jsonify({"models": models, "default": default_model})

@app.post("/api/fetch-headlines")
def api_fetch_headlines():
    data = request.get_json(force=True) or {}
    group = data.get("group")
    if not group:
        return jsonify({"error": "Missing 'group'"}), 400
    items = rss_manager.fetch_group(group)
    # Save latest headlines to JSON per group
    try:
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in str(group))
        payload = {"group": group, "fetched_at": datetime.now().isoformat(), "items": items}
        out_path = os.path.join(config.HEADLINES_DIR, f"{safe}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception:
        # Non-fatal: continue even if writing fails
        pass
    return jsonify({"items": items})

@app.post("/api/validate-feeds")
def api_validate_feeds():
    """Validate RSS feeds for accessibility and (optionally) scrappability.

    Body:
      group?: string  -> if provided, validate only this group; else validate all groups
      test_scrape?: bool (default true) -> try scraping a small sample of entries
      sample?: int (default 1) -> number of entries per feed to attempt scraping
      user_agent?: string -> override User-Agent header for fetching RSS

    Returns per-feed results with statuses and a summary count.
    """
    data = request.get_json(force=True) or {}
    group = data.get("group")
    test_scrape = bool(data.get("test_scrape", True))
    try:
        sample = int(data.get("sample", 1))
    except Exception:
        sample = 1
    sample = max(0, min(3, sample))
    ua = data.get("user_agent") or "NewsAssistant/1.0 (+local)"

    groups_to_check = [group] if group else rss_manager.list_groups()
    results = []
    for g in groups_to_check:
        feeds = rss_manager.get_group_feeds(g)
        for url in feeds:
            rec = {
                "group": g,
                "url": url,
                "http_status": None,
                "feed_ok": False,
                "entries": 0,
                "scrape_ok": None,
                "sample_tested": 0,
                "errors": []
            }
            # Fetch RSS
            content = None
            try:
                r = requests.get(url, headers={"User-Agent": ua}, timeout=12, allow_redirects=True)
                rec["http_status"] = r.status_code
                content = r.content
            except Exception as e:
                rec["errors"].append(f"request:{type(e).__name__}")
                results.append(rec)
                continue

            # Parse RSS
            try:
                parsed = feedparser.parse(content)
                entries = getattr(parsed, "entries", []) or []
                rec["entries"] = len(entries)
                rec["feed_ok"] = (rec["http_status"] and 200 <= rec["http_status"] < 400) and len(entries) > 0 and not getattr(parsed, "bozo", 0)
            except Exception as e:
                rec["errors"].append(f"parse:{type(e).__name__}")
                entries = []

            # Optional scrape test on a small sample
            if test_scrape and rec["entries"] > 0:
                urls = []
                for entry in entries[: max(1, sample)]:
                    link = getattr(entry, "link", None)
                    if not link and isinstance(entry, dict):
                        link = entry.get("link")
                    if link:
                        urls.append(link)
                if urls:
                    try:
                        arts = article_scraper.scrape(urls)
                        rec["sample_tested"] = len(arts)
                        ok_count = 0
                        for a in arts:
                            try:
                                content = (a.get("content") or "").strip()
                                if len(content) >= 300:
                                    ok_count += 1
                            except Exception:
                                pass
                        # Consider scrape OK if at least one sample article yields substantive content
                        rec["scrape_ok"] = ok_count > 0
                        if ok_count == 0:
                            rec["errors"].append("scrape:empty")
                    except Exception as e:
                        rec["errors"].append(f"scrape:{type(e).__name__}")
                        rec["scrape_ok"] = False
                else:
                    rec["scrape_ok"] = False

            results.append(rec)

    total = len(results)
    ok = sum(1 for r in results if r.get("feed_ok") and (not test_scrape or r.get("scrape_ok") is True))
    return jsonify({
        "total": total,
        "ok": ok,
        "test_scrape": test_scrape,
        "results": results
    })

@app.post("/api/prune-feeds")
def api_prune_feeds():
    """Auto-prune failing feeds from feeds.json and reload groups.

    Body:
      group?: string -> prune only this group; else all groups
      test_scrape?: bool (default true) -> consider scrape failures as failing
      sample?: int (default 1) -> entries per feed to test when scraping
      user_agent?: string -> UA for RSS fetch
      dry_run?: bool (default true) -> if true, don't modify files; just report

    A feed is considered failing if feed_ok is False OR (test_scrape and scrape_ok is False).
    """
    data = request.get_json(force=True) or {}
    group = data.get("group")
    test_scrape = bool(data.get("test_scrape", True))
    try:
        sample = int(data.get("sample", 1))
    except Exception:
        sample = 1
    sample = max(0, min(3, sample))
    ua = data.get("user_agent") or "NewsAssistant/1.0 (+local)"
    dry_run = bool(data.get("dry_run", True))

    # Reuse validation logic inline (duplicated for simplicity)
    groups_to_check = [group] if group else rss_manager.list_groups()
    validation = []
    for g in groups_to_check:
        feeds = rss_manager.get_group_feeds(g)
        for url in feeds:
            rec = {
                "group": g,
                "url": url,
                "http_status": None,
                "feed_ok": False,
                "entries": 0,
                "scrape_ok": None,
                "sample_tested": 0,
                "errors": []
            }
            # Fetch RSS
            content = None
            try:
                r = requests.get(url, headers={"User-Agent": ua}, timeout=12, allow_redirects=True)
                rec["http_status"] = r.status_code
                content = r.content
            except Exception as e:
                rec["errors"].append(f"request:{type(e).__name__}")
                validation.append(rec)
                continue

            # Parse RSS
            try:
                parsed = feedparser.parse(content)
                entries = getattr(parsed, "entries", []) or []
                rec["entries"] = len(entries)
                rec["feed_ok"] = (rec["http_status"] and 200 <= rec["http_status"] < 400) and len(entries) > 0 and not getattr(parsed, "bozo", 0)
            except Exception as e:
                rec["errors"].append(f"parse:{type(e).__name__}")
                entries = []

            # Optional scrape test
            if test_scrape and rec["entries"] > 0:
                urls = []
                for entry in entries[: max(1, sample)]:
                    link = getattr(entry, "link", None)
                    if not link and isinstance(entry, dict):
                        link = entry.get("link")
                    if link:
                        urls.append(link)
                if urls:
                    try:
                        arts = article_scraper.scrape(urls)
                        rec["sample_tested"] = len(arts)
                        ok_count = 0
                        for a in arts:
                            try:
                                content = (a.get("content") or "").strip()
                                if len(content) >= 300:
                                    ok_count += 1
                            except Exception:
                                pass
                        rec["scrape_ok"] = ok_count > 0
                        if ok_count == 0:
                            rec["errors"].append("scrape:empty")
                    except Exception as e:
                        rec["errors"].append(f"scrape:{type(e).__name__}")
                        rec["scrape_ok"] = False
                else:
                    rec["scrape_ok"] = False

            validation.append(rec)

    # Compute failing URLs per group
    failing_by_group: Dict[str, List[str]] = {}
    for rec in validation:
        feed_fail = (not rec.get("feed_ok")) or (test_scrape and rec.get("scrape_ok") is False)
        if feed_fail:
            g = rec.get("group")
            failing_by_group.setdefault(g, []).append(rec.get("url"))

    # Prepare new groups dict
    current = dict(rss_manager.groups)
    new_groups = {}
    removed = []
    for g, urls in current.items():
        bad = set(failing_by_group.get(g, []))
        kept = [u for u in urls if u not in bad]
        new_groups[g] = kept
        for u in urls:
            if u in bad:
                removed.append({"group": g, "url": u})

    if not dry_run:
        try:
            # Create timestamped backup
            try:
                from datetime import datetime as _dt
                backup_path = rss_manager.feeds_path + "." + _dt.now().strftime("%Y%m%d%H%M%S") + ".bak"
                with open(rss_manager.feeds_path, "r", encoding="utf-8") as rf:
                    _old = rf.read()
                with open(backup_path, "w", encoding="utf-8") as bf:
                    bf.write(_old)
            except Exception:
                # Non-fatal if backup fails
                pass

            # Write to feeds.json
            with open(rss_manager.feeds_path, "w", encoding="utf-8") as f:
                json.dump(new_groups, f, ensure_ascii=False, indent=2)
            # Reload in-memory
            rss_manager.groups = new_groups
        except Exception as e:
            return jsonify({
                "error": f"Failed to write feeds.json: {type(e).__name__}",
                "removed": removed,
                "validation": validation
            }), 500

    return jsonify({
        "dry_run": dry_run,
        "removed_count": len(removed),
        "removed": removed,
        "validation_total": len(validation),
        "failing_by_group": failing_by_group,
        "test_scrape": test_scrape
    })

@app.post("/api/scrape")
def api_scrape():
    data = request.get_json(force=True) or {}
    urls: List[str] = data.get("urls", [])
    if not urls:
        return jsonify({"error": "Missing 'urls'"}), 400
    results = article_scraper.scrape(urls)
    return jsonify({"articles": results})

@app.post("/api/summarize")
def api_summarize():
    data = request.get_json(force=True) or {}
    query = data.get("query", "")
    headlines: List[Dict] = data.get("headlines", [])
    model = data.get("model") or None
    try:
        result = llm.summarize_headlines_structured(query=query, headlines=headlines, model=model)
        return jsonify({
            "summary": result.get("summary", ""),
            "mentions": result.get("mentions", [])
        })
    except Exception:
        # Fallback to plain summary if anything goes wrong
        summary = llm.summarize_headlines(query=query, headlines=headlines, model=model)
        return jsonify({"summary": summary, "mentions": []})

@app.post("/api/generate")
def api_generate():
    data = request.get_json(force=True) or {}
    query = data.get("query", "")
    tone = data.get("tone", "neutral")
    length = data.get("length", "medium")
    articles: List[Dict] = data.get("articles", [])
    model = data.get("model") or None
    article_text = llm.generate_article(query=query, articles=articles, tone=tone, length=length, model=model)
    return jsonify({"article": article_text})

@app.post("/api/tts")
def api_tts():
    data = request.get_json(force=True) or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"error": "Missing 'text'"}), 400
    if _tts_engine is None:
        return jsonify({"error": "TTS engine not available"}), 500

    def _speak(t: str):
        try:
            _tts_engine.say(t)
            _tts_engine.runAndWait()
        except Exception:
            pass

    threading.Thread(target=_speak, args=(text,), daemon=True).start()
    return jsonify({"status": "speaking"})

@app.post("/api/pdf")
def api_pdf():
    from fpdf import FPDF
    data = request.get_json(force=True) or {}
    text = data.get("text", "").strip()
    title = data.get("title", "Generated Article")
    if not text:
        return jsonify({"error": "Missing 'text'"}), 400

    filename = f"article_{int(time.time())}.pdf"
    out_path = os.path.join(config.STATIC_EXPORT_DIR, filename)

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()
    pdf.set_font("Arial", "B", 16)
    pdf.multi_cell(0, 10, title)
    pdf.ln(4)
    pdf.set_font("Arial", size=12)
    for line in text.splitlines():
        pdf.multi_cell(0, 8, line)
    pdf.output(out_path)

    rel = os.path.relpath(out_path, os.path.dirname(config.FRONTEND_DIR))
    # Serve via a simple static endpoint
    return jsonify({
        "file": filename,
        "path": f"/api/exports/{filename}"
    })

@app.get("/api/exports/<path:filename>")
def api_get_export(filename: str):
    directory = config.STATIC_EXPORT_DIR
    return send_from_directory(directory, filename, as_attachment=True)


# --- Video extraction and proxy ---
@app.post("/api/find-videos")
def api_find_videos():
    data = request.get_json(force=True) or {}
    urls: List[str] = data.get("urls", [])
    if not urls:
        return jsonify({"videos": []})
    try:
        vids = article_scraper.find_videos(urls)
        return jsonify({"videos": vids})
    except Exception as e:
        return jsonify({"videos": [], "error": str(e)}), 500


@app.get("/api/proxy-video")
def api_proxy_video():
    # Simple streaming proxy. Note: Does not implement Range requests.
    src = request.args.get("url")
    if not src:
        return jsonify({"error": "Missing 'url'"}), 400
    try:
        # Use a generic browser-like UA to reduce blocks
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        }
        r = requests.get(src, headers=headers, stream=True, timeout=20)
        def generate():
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk
        resp = Response(stream_with_context(generate()), status=r.status_code)
        # Pass through key headers when present
        ct = r.headers.get("Content-Type")
        if ct:
            resp.headers["Content-Type"] = ct
        cl = r.headers.get("Content-Length")
        if cl:
            resp.headers["Content-Length"] = cl
        # Avoid caching issues
        resp.headers["Cache-Control"] = "no-cache"
        return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 502


def create_app():
    return app

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
