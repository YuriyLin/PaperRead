"""Emergency stop for experimental PDF table parsing; no persisted settings."""
import os

DISABLED = "Experimental table extraction is disabled"


def enabled():
    return os.environ.get("PAPERREAD_DISABLE_TABLE_EXTRACTION", "").strip().lower() not in {"1", "true", "yes", "on"}
