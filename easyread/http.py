"""HTTPS with system trust and bundled roots, including in frozen builds."""
from __future__ import annotations

import os
import ssl
import json
import urllib.error
import urllib.request
from functools import lru_cache

import certifi
import truststore


@lru_cache(maxsize=4)
def _context(cafile: str | None, capath: str | None):
    context = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # Native trust handles macOS Keychain / Windows roots; certifi also makes
    # Linux and PyInstaller builds independent of build-machine CA paths.
    context.load_verify_locations(cafile=certifi.where())
    if cafile or capath:
        context.load_verify_locations(cafile=cafile or None, capath=capath or None)
    return context


def urlopen(url, *args, **kwargs):
    # urllib can redirect an HTTP request to HTTPS, so use this context for
    # both schemes. It keeps hostname and certificate verification enabled.
    kwargs.setdefault("context", _context(os.environ.get("SSL_CERT_FILE"), os.environ.get("SSL_CERT_DIR")))
    return urllib.request.urlopen(url, *args, **kwargs)


GEMINI_VALIDATION_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _validation_open(request, timeout):
    # No inherited proxy credentials, custom CA file paths, redirects or retry.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect(),
                                        urllib.request.HTTPSHandler(context=_context(None, None)))
    return opener.open(request, timeout=timeout)


def gemini_validation_post(body: dict, authorization) -> dict:
    """One HTTP attempt, counted here immediately before the network boundary."""
    from .gemini_validation import Authorization, ValidationError
    if type(authorization) is not Authorization:
        raise ValidationError("Explicit Gemini validation authorization is required")
    key = authorization.claim(body)  # Also binds mode, payload and source identity.
    try:
        request = urllib.request.Request(GEMINI_VALIDATION_URL, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + key}, method="POST")
        with _validation_open(request, timeout=90) as response:
            if response.status != 200:
                raise ValidationError("Gemini did not return HTTP 200; no retry")
            raw = response.read(4_000_001)
        if len(raw) > 4_000_000:
            raise ValidationError("Gemini response is too large; no retry")
        text = raw.decode("utf-8")
        value = json.loads(text)
        # Table output must itself be strict JSON. Check after this decoding as
        # well, so a reflected Key hidden in JSON Unicode escapes cannot persist.
        table_output = json.loads(value["choices"][0]["message"]["content"])
        if key in text or key in json.dumps(value, ensure_ascii=False) or key in json.dumps(table_output, ensure_ascii=False):
            raise ValidationError("Gemini response contained credential material; discarded")
        return value
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        raise ValidationError(f"Gemini HTTP {code}; stopped without retry") from None
    except ValidationError:
        raise
    except Exception:
        # Never include provider bodies, request headers, exception repr or Key.
        raise ValidationError("Gemini transport or response failed; stopped without retry") from None
    finally:
        key = ""
        authorization.close()
