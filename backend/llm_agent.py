from __future__ import annotations
import os
import requests
from typing import List, Dict, Any
from . import config
import json
import re

class LLMAgent:
    def __init__(self, base_url: str | None = None, model: str | None = None):
        self.base_url = base_url or config.OLLAMA_BASE_URL
        self.model = model or config.OLLAMA_MODEL

    def _chat(self, messages: List[Dict[str, str]], temperature: float = 0.3, model: str | None = None, timeout: int = 120) -> str:
        # Uses Ollama's /api/chat endpoint
        url = f"{self.base_url}/api/chat"
        selected_model = model or self.model
        payload: Dict[str, Any] = {
            "model": selected_model,
            "messages": messages,
            "stream": False,
            "options": {"temperature": temperature}
        }
        r = requests.post(url, json=payload, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        # Ollama returns {message: {role, content}}
        if isinstance(data, dict) and "message" in data:
            return data["message"].get("content", "")
        # Fallback to generate endpoint response shape
        return data.get("response", "") if isinstance(data, dict) else str(data)

    def summarize_headlines(self, query: str, headlines: List[Dict[str, str]], model: str | None = None) -> str:
        bullet_points = "\n".join([f"- {h.get('title','')} ({h.get('source','')})" for h in headlines[:20]])
        system = "You are a helpful news assistant. Summarize headlines concisely with key themes and notable items."
        user = f"User intent: {query}\n\nHeadlines:\n{bullet_points}\n\nSummarize the main themes in 5-8 bullets."
        return self._chat([
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ], model=model)

    def summarize_headlines_structured(self, query: str, headlines: List[Dict[str, str]], model: str | None = None) -> Dict[str, Any]:
        """
        Ask the LLM to return a JSON object with fields:
        {
          "summary": string,
          "mentions": [ {"url": string} | {"title": string} | {"index": number} ]
        }
        Mentions should reference items from the provided headlines list, preferably by exact URL.
        """
        # Build a compact context the model can reliably reference
        ctx_items = []
        for i, h in enumerate(headlines[:30]):
            ctx_items.append({
                "index": i,  # zero-based index
                "title": h.get("title", ""),
                "url": h.get("link", ""),
                "source": h.get("source", "")
            })

        system = (
            "You are a helpful news assistant. Write a concise summary of the headlines. "
            "Then output which items are most relevant to the user's intent as a JSON object ONLY."
        )
        user = (
            "User intent: " + str(query) + "\n\n" +
            "Headlines (JSON array):\n" + json.dumps(ctx_items, ensure_ascii=False) + "\n\n" +
            "Return ONLY a JSON object with this exact schema (no extra text):\n" +
            "{\n  \"summary\": string,\n  \"mentions\": [ {\"url\": string} | {\"title\": string} | {\"index\": number} ]\n}\n" +
            "Rules: Prefer {\"url\"} when possible; if URL missing, use {\"index\"} from the given array; "
            "otherwise fall back to {\"title\"}. Keep mentions to the top 3-8 most relevant items."
        )

        content = self._chat([
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ], model=model)

        def _extract_json(txt: str) -> Dict[str, Any]:
            # Try direct parse
            try:
                return json.loads(txt)
            except Exception:
                pass
            # Try inside code fences
            fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", txt, re.IGNORECASE)
            if fence:
                inner = fence.group(1)
                try:
                    return json.loads(inner)
                except Exception:
                    pass
            # Fallback: grab first JSON-looking block
            start = txt.find('{')
            end = txt.rfind('}')
            if start != -1 and end != -1 and end > start:
                try:
                    return json.loads(txt[start:end+1])
                except Exception:
                    pass
            return {"summary": txt.strip(), "mentions": []}

        data = _extract_json(content or "")
        # Validate shape
        summary = data.get("summary") if isinstance(data, dict) else None
        mentions = data.get("mentions") if isinstance(data, dict) else None
        if not isinstance(summary, str):
            summary = self.summarize_headlines(query=query, headlines=headlines, model=model)
        if not isinstance(mentions, list):
            mentions = []
        # Normalize mentions entries
        norm_mentions: List[Dict[str, Any]] = []
        for m in mentions:
            if isinstance(m, dict):
                pick: Dict[str, Any] = {}
                if isinstance(m.get("url"), str) and m.get("url"):
                    pick["url"] = m["url"]
                elif isinstance(m.get("index"), int):
                    pick["index"] = m["index"]
                elif isinstance(m.get("title"), str) and m.get("title"):
                    pick["title"] = m["title"]
                if pick:
                    norm_mentions.append(pick)
            elif isinstance(m, str):
                # Treat as URL or title string when LLM returns bare strings
                if m.startswith("http://") or m.startswith("https://"):
                    norm_mentions.append({"url": m})
                else:
                    norm_mentions.append({"title": m})
            elif isinstance(m, int):
                norm_mentions.append({"index": m})

        return {"summary": summary, "mentions": norm_mentions}

    def generate_article(self, query: str, articles: List[Dict[str, str]], tone: str = "neutral", length: str = "medium", model: str | None = None) -> str:
        joined = "\n\n".join([f"TITLE: {a.get('title','')}\nURL: {a.get('url','')}\nCONTENT:\n{a.get('content','')[:6000]}" for a in articles])
        system = (
            "You are an expert news writer. Write a coherent, factual article with citations as [n] linking to the URLs. "
            "Include a short intro, well-structured body with subheadings, and a brief conclusion."
        )
        user = (
            f"User intent: {query}\nTone: {tone}\nLength: {length}\n\n"
            f"Source material (one or more articles):\n{joined}\n\n"
            "Write the article now."
        )
        return self._chat([
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ], temperature=0.5, model=model, timeout=240)
