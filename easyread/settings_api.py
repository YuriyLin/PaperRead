"""设置页的保存类接口（POST）。server.py 按路径转过来，每个函数收请求体、返回要回给页面的 JSON。"""
from __future__ import annotations

from . import chat_models, config, engines, langs, mineru, openai_api
from .i18n import tr


def save_config(patch: dict) -> dict:
    patch.pop("library_dir", None)
    if "page_cap" in patch and (type(patch["page_cap"]) is not int or patch["page_cap"] < 0):
        raise ValueError(tr("页数确认上限必须是非负整数"))
    if "local_references" in patch:
        patch["local_references"] = bool(patch["local_references"])
    if "target" in patch:
        patch["target"] = langs.valid(patch["target"])
    if isinstance(patch.get("openai"), dict):
        patch["openai"] = config.with_key(patch["openai"])
    if isinstance(patch.get("mineru"), dict):
        patch["mineru"] = config.with_mineru_token(patch["mineru"])
    return {"config": config.public(config.save(patch))}


def save_chat_models(body: dict) -> dict:
    """保存“问 AI”的名单和默认模型；或面板里只改默认。"""
    patch = {}
    if "models" in body:
        patch["models"] = chat_models.sanitize(body["models"])
    if body.get("default"):
        patch["default"] = str(body["default"])
    full = {"chat": patch}
    if isinstance(body.get("keys"), dict):  # 设置里给某家 API 填的 Key，和翻译那边共用
        keys = dict(config.load()["openai"].get("keys") or {})
        keys.update({str(k): str(v).strip() for k, v in body["keys"].items() if v and not str(v).startswith("••••")})
        full["openai"] = {"keys": keys}
    config.save(full)
    return chat_models.listing(config.load())


def test_engine(body: dict) -> dict:
    cfg = config.load()
    engine = body.get("engine") or cfg.get("engine")
    if not engine or engine == "none":
        return {"ok": False, "message": tr("没有配置翻译引擎（设置 → 模型）")}
    cfg["engine"] = engine
    if isinstance(body.get(engine), dict):
        cfg.setdefault(engine, {}).update(body[engine])
    elif body.get("model"):
        cfg.setdefault(engine, {})["model"] = body["model"]
        if "reasoning_effort" in body:
            cfg[engine]["reasoning_effort"] = body["reasoning_effort"]
    return engines.test(cfg)


def list_models(body: dict) -> dict:
    """设置页“获取模型列表”：{base_url, preset, api_key}；Key 留空或打码时用这家已存的。"""
    key = str(body.get("api_key") or "").strip()
    if not key or key.startswith("••••"):
        key = (config.load()["openai"].get("keys") or {}).get(str(body.get("preset") or ""), "")
    try:
        return {"ok": True, "models": openai_api.models({"base_url": body.get("base_url"), "api_key": key})}
    except engines.EngineError as e:
        return {"ok": False, "message": str(e)[:300]}


def test_mineru(body: dict) -> dict:
    cfg = config.load()
    mcfg = dict(cfg.get("mineru") or {})
    if isinstance(body.get("mineru"), dict):
        incoming = config.with_mineru_token(body["mineru"])
        mcfg.update(incoming)
    return mineru.test_connection(mcfg, smoke=bool(body.get("smoke")))


POST = {"/api/config": save_config, "/api/chat/models": save_chat_models,
        "/api/config/test": test_engine, "/api/models/list": list_models,
        "/api/mineru/test": test_mineru}
