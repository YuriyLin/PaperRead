"""“问 AI”的回答方式；和使用哪个模型分开选择。"""

from .i18n import tr

DEFAULT = "standard"
STE100 = "ste100"
XRAY = "xray"
VALUES = (DEFAULT, STE100, XRAY)
WHOLE_PAPER = (STE100, XRAY)


def parse(value=None) -> str:
    if value is None:
        return DEFAULT
    if value not in VALUES:
        raise ValueError(tr("回答方式只能是 standard / ste100 / xray"))
    return value


# Original instructions based on ASD-STE100 Issue 9 (2025-01-15).
# STE is an English standard. This mode applies its clarity principles to Chinese.
# This is a writing aid, not a dictionary validator or a compliance certificate.
# Reference: https://www.asd-ste100.org/STE_faq.html
# Additional clarity principles reviewed (original Chinese instructions below):
# https://github.com/danyuchn/asd-ste100-skill/blob/7d4a135a199a5d7447c4886bcd7ffe742a627bc9/SKILL.md
def ste100_instructions(meta: dict | None = None) -> str:
    from . import langs
    target = (meta or {}).get("target")
    lang_desc = langs.reply_lang(meta)
    if target == "zh-TW" or lang_desc == langs.prompt_name("zh-TW"):
        target_rule = "只輸出繁體中文回答，不附英文答案、英文草稿或雙語對照；不可使用簡體字。專業名詞、縮寫、程式碼和公式可以保留必要的原文。"  # i18n-ok
        std_rule = "ASD-STE100 是英文標準。本模式借鑑 Issue 9 的簡明技術寫作原則，使用這些原則組織中文答案；不要把英文的詞數限制機械地套用到中文，也不要聲稱中文答案符合英文標準。"  # i18n-ok
    elif target == "zh" or lang_desc == "中文":  # i18n-ok
        target_rule = "只輸出中文回答，不附英文答案、英文草稿或雙語對照。專業名詞、縮寫、程式碼和公式可以保留必要的原文。"  # i18n-ok
        std_rule = "ASD-STE100 是英文標準。本模式借鑑 Issue 9 的簡明技術寫作原則，使用這些原則組織中文答案；不要把英文的詞數限制機械地套用到中文，也不要聲稱中文答案符合英文標準。"  # i18n-ok
    elif target == "en" or "英文" in lang_desc or "English" in lang_desc:  # i18n-ok
        target_rule = "只輸出英文（English）回答，不附雙語對照。專業名詞、縮寫、程式碼和公式可以保留必要的原文。"  # i18n-ok
        std_rule = "ASD-STE100 是英文標準。本模式依據 Issue 9 的簡明技術寫作原則組織英文答案；不要聲稱答案已通過 STE 詞典校驗或標準認證。"  # i18n-ok
    else:
        target_rule = f"只輸出{lang_desc}回答，不附英文答案、英文草稿或雙語對照。專業名詞、縮寫、程式碼和公式可以保留必要的原文。"  # i18n-ok
        std_rule = f"ASD-STE100 是英文標準。本模式借鑑 Issue 9 的簡明技術寫作原則，使用這些原則組織{lang_desc}答案；不要把英文的詞數限制機械地套用，也不要聲稱答案符合英文標準。"  # i18n-ok

    return f"""本次使用 ASD-STE100 問答模式。先前的對話只提供語境，不決定本次的語言和格式。
{target_rule}
{std_rule}
- 使用簡明、直接的短句，每句表達一個主要意思，每段圍繞一個主題。三個或更多步驟、條件或並列要點使用列表。
- 優先使用主動表達，明確誰做什麼、動作涉及哪個對象。不知道行為主體時不要猜測，也不要省略主語造成歧義。
- 讀者需要操作說明時，先說明適用條件，再依序列出動作和必要的結果或限制；每一步說明一個動作。不要把描述性結論改成操作命令。
- 避免習語、含糊的代詞、複雜的句式和不必要的修飾語。
- 一個概念始終使用同一個詞，不用同義詞來回替換。
- 保留論文的專業名詞、縮寫、公式、數值和單位；首次使用時，用短句解釋必要的專業名詞。
- 保留適用範圍、實驗條件、例外和論斷的語氣強度。「可能」不能改成「確定」，「建議」不能改成「必須」，「部分」不能改成「全部」；沒有報告的結果不能當成沒有該效應。
- 論文提供效能數值和對照條件時，優先用這些依據解釋效能。不用宣傳性評價，不補造原文未說明的頻率、原因、機制或效能保證。需要背景知識時標明是補充解釋。
- 準確性優先於簡短。可以分句，但不能刪掉關鍵條件、因果關係、時間關係或不確定性；更短的表達會遺失必要資訊時，保留完整表達。
區分論文證據和補充解釋。當前正文不完整或只提供節錄時，涉及全文的結論必須說明這個範圍。
輸出前先檢查事實、數值、條件、範圍和語氣強度是否忠於依據，再檢查術語是否一致和表達是否清楚；不要輸出檢查過程，也不要聲稱答案已通過 STE 詞典校驗或標準認證。
"""


STE100_INSTRUCTIONS = ste100_instructions({"target": "zh-TW"})

# Based on EasyRead's MIT-licensed paper-xray / answer style (upstream PR #41).
XRAY_INSTRUCTIONS = """本次使用精讀模式。圍繞讀者的問題深入解釋，不必每次都產生整篇閱讀報告。先前對話只提供語境，不決定本次的回答方式。
- 還原作者要解決的具體問題、前人方法的瓶頸與核心假設。論文沒有說明動機時，明確寫「論文沒有說明」，不要替作者編造思考過程。
- 說明方法的資料流與設計理由，區分關鍵機制和附加設計。用消融、正文或附錄判斷設計是否必要；缺少對照就寫「論文沒有做這個對照」，不可把推測當成結論。
- 解釋關鍵公式的符號、意義、維度或張量形狀；適用時提供可以手算的微型數值例子並算出結果，清楚標示這是教學示例，不是論文實驗數據。
- 解讀實驗真正支持的主張，檢查資料集、指標、基線條件、訓練步數、調參預算、消融、超參選擇、資料洩漏與計算成本。只在已提供的內容足以核對時判斷數字是否一致；未提供圖表影像時，不可聲稱已看過或核對原圖。
- 區分作者明述的限制、實驗顯示的限制與你的推論；保留原文語氣強度，「可能」不能寫成「確定」，「部分」不能寫成「全部」。沒有報告的條件或數值就寫「論文沒有報告」。
- 指出相關章節、頁碼或公式供讀者回查，不捏造引用。正文被節錄、整理未完成或附錄未提供時，說明覆蓋範圍；不能把未提供的內容視為已讀。
"""
