from __future__ import annotations
import threading
import webview
try:
    # Running as a package/module: python -m news_assistant.main
    from .backend.app import create_app  # type: ignore
except Exception:
    # Fallback when executed as a script: python news_assistant/main.py
    # Use absolute import by temporarily adding this directory to sys.path
    import os, sys
    sys.path.append(os.path.dirname(os.path.abspath(__file__)))
    from backend.app import create_app  # type: ignore


def run_flask():
    app = create_app()
    # Use separate thread; don't use debug reloader in packaged app
    app.run(host="127.0.0.1", port=5000, debug=False, use_reloader=False)


def main():
    t = threading.Thread(target=run_flask, daemon=True)
    t.start()
    # Give Flask a moment to start
    window = webview.create_window("News Assistant", url="http://127.0.0.1:5000/")
    webview.start()


if __name__ == "__main__":
    main()
