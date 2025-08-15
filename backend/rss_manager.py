import json
import os
from typing import Dict, List
import feedparser

FEEDS_FILE = os.path.join(os.path.dirname(__file__), "feeds.json")

class RSSManager:
    def __init__(self, feeds_path: str | None = None):
        self.feeds_path = feeds_path or FEEDS_FILE
        if not os.path.exists(self.feeds_path):
            self._write_default_feeds()
        self.groups = self._load_feeds()

    def _load_feeds(self) -> Dict[str, List[str]]:
        with open(self.feeds_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write_default_feeds(self):
        defaults = {
            "uk_football": [
                "https://feeds.bbci.co.uk/sport/football/rss.xml",
                "https://www.skysports.com/rss/12040",
                "https://www.theguardian.com/football/rss"
            ],
            "tech": [
                "https://feeds.arstechnica.com/arstechnica/index",
                "https://www.theverge.com/rss/index.xml",
                "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml"
            ]
        }
        with open(self.feeds_path, "w", encoding="utf-8") as f:
            json.dump(defaults, f, indent=2)

    def list_groups(self) -> List[str]:
        return list(self.groups.keys())

    def get_group_feeds(self, group: str) -> List[str]:
        return self.groups.get(group, [])

    def fetch_group(self, group: str) -> List[dict]:
        items: List[dict] = []
        for url in self.get_group_feeds(group):
            parsed = feedparser.parse(url)
            for entry in parsed.entries:
                items.append({
                    "title": getattr(entry, "title", ""),
                    "link": getattr(entry, "link", ""),
                    "summary": getattr(entry, "summary", ""),
                    "published": getattr(entry, "published", ""),
                    "source": parsed.feed.title if parsed.feed and getattr(parsed, 'feed', None) else url,
                })
        return items
