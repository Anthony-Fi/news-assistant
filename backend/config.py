import os

# Configuration for backend components
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:4b")  # Change to your preferred local model

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
STATIC_EXPORT_DIR = os.path.join(os.path.dirname(__file__), "static", "exports")
IMAGES_DIR = os.path.join(os.path.dirname(__file__), "static", "images")
HEADLINES_DIR = os.path.join(os.path.dirname(__file__), "static", "headlines")

os.makedirs(STATIC_EXPORT_DIR, exist_ok=True)
os.makedirs(IMAGES_DIR, exist_ok=True)
os.makedirs(HEADLINES_DIR, exist_ok=True)
