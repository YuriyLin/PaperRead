const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const answer = "## 结果\n误差为 2%。器件计算 $y=Wx$。\n\n## 局限\n测试采用室温和固定权重。";
const source = name => fs.readFileSync(path.join(__dirname, "../easyread/web/js/reader/" + name + ".js"), "utf8");
const settled = () => new Promise(resolve => setImmediate(resolve));

async function reader(threads = [], options = {}) {
  const listeners = new Map(), events = new Map(), nodes = new Map(), requests = [], copied = [], confirmations = [], focused = [];
  let finish;
  const pendingReads = [];
  const panelEvents = new Map();
  const panel = { addEventListener(name, fn) { panelEvents.set(name, fn); }, classList: { add() {}, remove() {} } };
  Object.defineProperty(panel, "innerHTML", {
    get() { return this.html || ""; },
    set(html) {
      this.html = html;
      const ta = { value: (html.match(/<textarea[^>]*>(.*?)<\/textarea>/s) || [])[1] || "", focus() {} };
      nodes.set("#chatInput", ta);
      nodes.set("#chatList", { scrollHeight: 100, scrollTop: 0, clientHeight: 100 });
      const button = (html.match(/<button class="ch-pill[^>]*data-c="style"[^>]*>/) || [""])[0];
      nodes.set("#chatAnswerStyle", {
        value: /aria-pressed="true"/.test(button) ? "ste100" : "standard",
        disabled: / disabled/.test(button), focus() { focused.push("style"); },
      });
      nodes.set("#chatStyleHelp", { hidden: /aria-labelledby="chatStyleHelpTitle" hidden/.test(html), focus() { focused.push("help"); } });
      nodes.set("#chatStyleHelpButton", {
        expanded: /aria-expanded="true" aria-controls="chatStyleHelp"/.test(html),
        setAttribute(name, value) { if (name === "aria-expanded") this.expanded = value === "true"; },
        focus() { focused.push("help-button"); },
      });
    },
  });
  nodes.set("#chatpanel", panel);
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    state: {}, store: { mode: "server" }, pid: "test", token: "test-token", side: null,
    $: selector => nodes.get(selector) || null,
    on(name, fn) { events.set(name, fn); }, openSide(side) { this.side = side; }, readingBlock: () => null, blockById: {}, myNotes: () => [],
    api: async () => ({ threads: structuredClone(threads), models: [{ id: "m", label: "Model" }, { id: "m2", label: "Other model" }], default: "m" }),
    confirm: async opts => { confirmations.push(opts); return true; },
    nowIso: () => "2026-01-01T00:00:00Z", shortTime: () => "today", autosize() {}, imageUrl: name => "/p/test/" + name,
    esc: text => String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), errorText: error => String(error?.message || error), icon: () => "", logo: () => "", md: text => text, mdBlocks: text => text,
    throttle: fn => fn, debounce: fn => fn, usageChip: () => "", usagePop: () => "", toast() {},
  };
  if (options.markup) vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../easyread/web/js/common/markup.js"), "utf8"), {
    window: { PR }, katex: require("../easyread/web/vendor/katex/katex.min.js"),
  });
  vm.runInNewContext(source("chat-effort"), { window: { PR } });
  vm.runInNewContext(source("chat-images") + "\n" + source("chat"), {
    window: { PR, addEventListener() {} },
    document: { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } },
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    setTimeout() {}, AbortController, TextDecoder,
    FileReader: class { readAsDataURL(file) { this.result = file.data; if (options.slowImages) pendingReads.push(() => this.onload()); else this.onload(); } },
    fetch: async (url, opts) => {
      requests.push(JSON.parse(opts.body));
      if (options.failFirst && requests.length === 1) return new Response(JSON.stringify({ error: "连接失败" }), { status: 400 });
      return new Response(new ReadableStream({
        start(ctrl) {
          opts.signal.addEventListener("abort", () => ctrl.error(Object.assign(new Error("Stopped"), { name: "AbortError" })));
          finish = () => {
            const events = [{ thread: "new", model: "Model", answer_style: requests.at(-1).answer_style },
              { t: answer }, { done: true, id: "answer" }];
            ctrl.enqueue(new TextEncoder().encode(events.map(e => JSON.stringify(e) + "\n").join("")));
            ctrl.close();
          };
        },
      }));
    },
  });
  const dispatch = async (name, target, extra = {}) => { for (const fn of listeners.get(name) || []) await fn({ target, ...extra }); };
  const action = (name, card, row) => ({ dataset: { c: name, m: name === "model" ? "m2" : undefined }, closest: selector => {
    if (selector === "#chatpanel") return panel;
    if (selector === "#chatStyleHelpButton" && name === "style-help") return nodes.get("#chatStyleHelpButton");
    if (selector === "#chatStyleHelp" && name === "style-help-close") return nodes.get("#chatStyleHelp");
    if (selector === "[data-c]") return actionTarget;
    if (selector === ".cm.ai") return card;
    if (selector === ".ch-thread[data-t]") return row;
    return null;
  } });
  let actionTarget;
  const click = (name, card, row) => { actionTarget = action(name, card, row); return dispatch("click", actionTarget); };
  const selectThread = id => {
    const row = { dataset: { t: id } };
    return dispatch("click", { closest: selector => selector.includes(".ch-thread[data-t]") ? row : selector === "#chatpanel" ? panel : null });
  };
  PR.toggleChat(true);
  await settled();
  const setStyle = async value => {
    const select = nodes.get("#chatAnswerStyle");
    if (!select.disabled && select.value !== value) await click("style");
  };
  return { PR, panel, nodes, requests, copied, confirmations, focused, dispatch, click, selectThread, setStyle,
    finishImages: () => pendingReads.splice(0).forEach(done => done()),
    paste: files => { let prevented = false; return Promise.resolve(panelEvents.get("paste")({ target: { id: "chatInput" }, clipboardData: { items: files.map(file => ({ kind: "file", type: file.type, getAsFile: () => file })) }, preventDefault: () => { prevented = true; } })).then(() => prevented); },
    emit: async name => { await events.get(name)(); await settled(); }, finish: () => finish() };
}

test("STE selection reaches the request, stays fixed during streaming, and copies the complete Chinese answer", async () => {
  const r = await reader();
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
  r.nodes.get("#chatInput").value = "总结论文";
  await r.setStyle("ste100");
  assert.equal(r.nodes.get("#chatInput").value, "总结论文");
  const sending = r.click("send");
  await settled();
  assert.equal(r.requests[0].answer_style, "ste100");
  assert.equal(r.nodes.get("#chatAnswerStyle").disabled, true);
  await r.setStyle("standard");
  r.finish();
  await sending;
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  assert.equal(r.nodes.get("#chatAnswerStyle").disabled, false);
  assert.ok(r.panel.innerHTML.includes('class="cm-style">简明回答</span>'));
  assert.ok(r.panel.innerHTML.includes('class="ch-pill on"'));
  assert.ok(!r.panel.innerHTML.includes("英文在前"));
  assert.ok(r.panel.innerHTML.includes(answer));
  await r.click("copy", { dataset: { id: "answer" } });
  assert.deepEqual(r.copied, [answer]);
});

test("each saved conversation restores its mode; legacy and new conversations start in normal mode", async () => {
  const r = await reader([
    { id: "ste", title: "STE", answer_style: "ste100", messages: [{ id: "a", role: "assistant", content: answer, answer_style: "ste100" }] },
    { id: "old", title: "Old", messages: [{ id: "b", role: "assistant", content: "旧回答" }] },
  ]);
  await r.selectThread("ste");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  assert.ok(r.panel.innerHTML.includes("cm-style"));
  await r.selectThread("old");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
  assert.ok(!r.panel.innerHTML.includes("cm-style"));
  await r.selectThread("ste");
  await r.click("new");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
});

test("both answer modes reach the request and old deep-reading threads open in standard mode", async () => {
  const r = await reader([{ id: "xray", title: "Deep reading", answer_style: "xray", messages: [] }]);
  await r.selectThread("xray");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
  for (const style of ["standard", "ste100"]) {
    await r.setStyle(style);
    r.nodes.get("#chatInput").value = "Explain the evidence";
    const sending = r.click("send"); await settled();
    assert.equal(r.requests.at(-1).answer_style, style);
    assert.equal(r.nodes.get("#chatAnswerStyle").disabled, true);
    r.finish(); await sending;
    assert.equal(r.nodes.get("#chatAnswerStyle").value, style);
  }
});

test("answer mode toggle preserves an unsent draft", async () => {
  const r = await reader();
  r.nodes.get("#chatInput").value = "My unsent question";
  await r.setStyle("ste100");
  assert.equal(r.nodes.get("#chatInput").value, "My unsent question");
  assert.match(r.panel.innerHTML, /data-c="style"[^>]*aria-pressed="true"/);
  assert.equal(r.requests.length, 0);
});

test("saved formulas render in answers, questions and thread titles without rewriting copy content", async () => {
  const content = String.raw`积分：\[\frac{1}{L}\int_0^L e^{-(a+j\beta)z}\,dz\]`;
  const r = await reader([{ id: "formula", title: String.raw`$\alpha$ 的解释 <img src=x>`, answer_style: "ste100", messages: [
    { id: "q", role: "user", content: String.raw`解释 \(\alpha\)。` },
    { id: "a", role: "assistant", content, answer_style: "ste100" },
  ] }], { markup: true });
  await r.selectThread("formula");
  assert.equal((r.panel.innerHTML.match(/class="katex"/g) || []).length, 3);
  assert.ok(r.panel.innerHTML.includes('class="katex-display"'));
  assert.ok(r.panel.innerHTML.includes("&lt;img src=x&gt;"));
  assert.ok(!r.panel.innerHTML.includes("<img"));
  await r.click("list");
  assert.equal((r.panel.innerHTML.match(/class="katex"/g) || []).length, 4);
  await r.click("copy", { dataset: { id: "a" } });
  assert.deepEqual(r.copied, [content]);
});

test("switching conversation during a streamed answer cannot change the visible mode", async () => {
  const r = await reader([{ id: "old", title: "Old", messages: [] }]);
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "question";
  const sending = r.click("send");
  await settled();
  await r.selectThread("old");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  r.finish();
  await sending;
  assert.ok(r.panel.innerHTML.includes(answer));
});

test("saving model settings keeps the chosen mode and unsent draft", async () => {
  const r = await reader([{ id: "old", title: "Old", answer_style: "standard", messages: [] }]);
  await r.selectThread("old");
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "还没发送的问题";
  await r.emit("settings-saved");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  assert.equal(r.nodes.get("#chatInput").value, "还没发送的问题");
});

test("saving settings during an answer cannot discard the active conversation", async () => {
  const r = await reader();
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "正在回答的问题";
  const sending = r.click("send");
  await settled();
  await r.emit("settings-saved");
  assert.ok(r.panel.innerHTML.includes("正在回答的问题"));
  assert.equal(r.nodes.get("#chatAnswerStyle").disabled, true);
  r.finish();
  await sending;
  assert.ok(r.panel.innerHTML.includes(answer));
});

test("the selected model and mode return together when switching back to a conversation", async () => {
  const r = await reader([
    { id: "first", title: "First", model: "m", messages: [] },
    { id: "second", title: "Second", model: "m", messages: [] },
  ]);
  await r.selectThread("first");
  await r.setStyle("ste100");
  await r.click("model");
  r.nodes.get("#chatInput").value = "用另一模型回答";
  const sending = r.click("send");
  await settled();
  assert.equal(r.requests[0].model, "m2");
  r.finish();
  await sending;
  await r.selectThread("second");
  await r.selectThread("first");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  assert.ok(r.panel.innerHTML.includes('title="换模型和思考强度">Other model'));
});

test("a streamed conversation cannot be deleted; stopping enables a new normal conversation", async () => {
  const r = await reader([{ id: "old", title: "Old", messages: [] }]);
  await r.selectThread("old");
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "正在回答的问题";
  const sending = r.click("send");
  await settled();
  await r.click("del", null, { dataset: { t: "old" } });
  assert.equal(r.confirmations.length, 0);
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  await r.click("stop");
  await sending;
  assert.equal(r.nodes.get("#chatAnswerStyle").disabled, false);
  assert.ok(r.panel.innerHTML.includes("已停止"));
  await r.click("new");
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
});

test("a failed first question can be left for a new conversation and retried without leaking a local ID", async () => {
  const r = await reader([], { failFirst: true });
  await r.setStyle("ste100");
  r.nodes.get("#chatInput").value = "失败的问题";
  await r.click("send");
  assert.ok(r.panel.innerHTML.includes("连接失败"));
  await r.click("list");
  const localId = r.panel.innerHTML.match(/data-t="([^"]*)"/)[1];
  await r.click("new");
  assert.ok(!r.panel.innerHTML.includes("失败的问题"));
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "standard");
  await r.selectThread(localId);
  assert.equal(r.nodes.get("#chatAnswerStyle").value, "ste100");
  r.nodes.get("#chatInput").value = "重试问题";
  const sending = r.click("send");
  await settled();
  assert.equal(r.requests[1].thread, null);
  r.finish();
  await sending;
  assert.ok(r.panel.innerHTML.includes(answer));
});

test("Markdown export includes all conversations and complete answers, online and offline", async () => {
  const chat = { threads: [
    { messages: [{ role: "user", content: "first" }, { role: "assistant", content: answer, model: "Model" }] },
    { messages: [{ role: "user", content: "second" }, { role: "assistant", content: "normal answer", model: "Model" }] },
  ] };
  for (const mode of ["server", "static"]) {
    let go, blob, downloaded = false;
    const dlg = { addEventListener(name, fn) { go = fn; }, classList: { remove() {} } };
    const exportButton = { disabled: false, innerHTML: "", textContent: "" };
    const panel = { addEventListener() {} };
    const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
      state: { paper: { meta: { title_en: "Test paper" }, blocks: [] }, reader: {}, discussion: {}, chat }, store: { mode }, pid: "test",
      $: selector => selector === "#readerDlg" ? dlg : panel,
      $$: selector => selector === "[data-exp-row]" ? [{ dataset: { expRow: "chat" } }] : [{ dataset: { exp: "chat" }, checked: true }], ls: { get: (k, fallback) => fallback, set() {} },
      api: async () => chat, myNotes: () => [], el: () => ({ click() { downloaded = true; }, remove() {} }),
      debounce: fn => fn,
    };
    const context = {
      window: { PR, addEventListener() {} }, document: { addEventListener() {}, body: { appendChild() {} } }, location: { search: "" }, URLSearchParams,
      Blob, URL: { createObjectURL(value) { blob = value; return "blob:test"; } },
    };
    dlg.addEventListener = (name, fn) => { go = fn; };
    PR.$ = selector => selector === "#readerDlg" ? dlg : selector === "#notespanel" ? panel : null;
    const target = { closest: selector => selector === "[data-exp-download]" ? exportButton : null };
    vm.runInNewContext(source("notespanel"), context);
    vm.runInNewContext(source("export"), context);
    await go({ target });
    const text = await blob.text();
    assert.ok(downloaded);
    assert.ok(text.includes(answer));
    assert.ok(text.includes("first"));
    assert.ok(text.includes("second"));
    assert.ok(text.includes("normal answer"));
  }
});

test("a failed chat export keeps the dialog open, creates no file, and treats the error as text", async () => {
  let go, closed = false, downloaded = false;
  const notices = [];
  const dlg = { addEventListener(name, fn) { go = fn; }, classList: { remove() { closed = true; } } };
  const exportButton = { disabled: false, innerHTML: "", textContent: "" };
  const PR = {
    t: (s, v) => v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s,
    state: { chat: {} }, store: { mode: "server" }, pid: "test",
    $: () => dlg, $$: () => [{ dataset: { exp: "chat" }, checked: true }], ls: { set() {} },
    api: async () => { throw new Error('<img src=x onerror="alert(1)">'); },
    esc: text => String(text).replace(/</g, "&lt;").replace(/>/g, "&gt;"), errorText: error => String(error?.message || error),
    toast: text => notices.push(text), notesMarkdown() { downloaded = true; },
  };
  vm.runInNewContext(source("export"), { window: { PR } });
  await go({ target: { closest: selector => selector === "[data-exp-download]" ? exportButton : null } });
  assert.equal(closed, false);
  assert.equal(downloaded, false);
  assert.ok(notices[0].includes('&lt;img'));
  assert.ok(!notices[0].includes('<img'));
});

test("thinking effort lives in the model menu and shows on the model button once chosen", async () => {
  const r = await reader([], {});
  r.PR.state.models = null;
  await r.click("menu");
  assert.ok(r.panel.innerHTML.includes('class="ch-effort-sec"'));
  assert.ok(!r.panel.innerHTML.includes("ch-effort-pop"));
  assert.ok(!r.panel.innerHTML.includes("ch-model-effort"));
  const b = { dataset: { c: "effort-level", effort: "high" }, closest: (sel) => sel === "[data-c]" ? b : sel === "#chatpanel" ? r.panel : null };
  await r.dispatch("click", b);
  assert.ok(r.panel.innerHTML.includes('class="ch-effort-sec"'), "menu stays open");
  assert.match(r.panel.innerHTML, /ch-model-effort"> · 高/);
  r.nodes.get("#chatInput").value = "问题";
  const sending = r.click("send");
  await settled();
  assert.equal(r.requests[0].chat_options.reasoning_effort, "high");
  r.finish(); await sending;
});

test("Ollama thinking menu reflects its on/off behavior and defaults to thinking off", async () => {
  const r = await reader([], {});
  const model = { engine: "openai", preset: "ollama", model: "qwen3.5-4b:latest" };
  assert.deepEqual(Array.from(r.PR.chatEffort.levels(model, {})), ["none", "high"]);
  assert.equal(r.PR.chatEffort.fallback({ catalog: {} }, model), "none");
});

const pastedImage = { type: "image/png", size: 20, data: "data:image/png;base64,aW1hZ2U=" };
test("pending image reads cannot enter a new or different conversation", async () => {
  for (const switchThread of [false, true]) {
    const r = await reader([{ id: "saved", title: "Saved", messages: [] }], { slowImages: true });
    const pending = r.paste([pastedImage]);
    if (switchThread) await r.selectThread("saved"); else await r.click("new");
    r.finishImages(); await pending;
    assert.ok(!r.panel.innerHTML.includes(pastedImage.data));
    const next = r.paste([pastedImage]);
    r.finishImages(); await next;
    assert.ok(r.panel.innerHTML.includes(pastedImage.data));
  }
});

test("clipboard images preview, can be removed, and travel with an image-only question", async () => {
  const r = await reader();
  assert.ok(r.panel.innerHTML.includes("输入问题，或粘贴截图…"));
  assert.ok(!r.panel.innerHTML.includes('class="ch-images"'));
  assert.equal(await r.paste([pastedImage]), true);
  assert.ok(r.panel.innerHTML.includes(pastedImage.data));
  assert.ok(r.panel.innerHTML.includes('aria-label="移除图片 1"'));
  await r.click("unimage", null, null, { i: "0" });
  assert.ok(!r.panel.innerHTML.includes(pastedImage.data));
  await r.paste([pastedImage]);
  const sending = r.click("send"); await settled();
  assert.equal(r.requests[0].text, "请解释这张图片。");
  assert.deepEqual(r.requests[0].images, [pastedImage.data]);
  r.finish(); await sending;
});

test("paste validation retains text and failed sends retain images until a new conversation", async () => {
  const r = await reader([], { failFirst: true });
  r.nodes.get("#chatInput").value = "Keep this question";
  assert.equal(await r.paste([]), false, "plain text stays with the browser");
  await r.paste(Array(5).fill(pastedImage));
  assert.ok(r.panel.innerHTML.includes('role="alert"'));
  assert.ok(r.panel.innerHTML.includes("最多粘贴 4 张"));
  assert.equal(r.nodes.get("#chatInput").value, "Keep this question");
  await r.paste([{ ...pastedImage, type: "image/svg+xml" }]);
  assert.ok(r.panel.innerHTML.includes("仅支持 PNG"));
  await r.paste([{ ...pastedImage, size: 9 * 1024 * 1024 }]);
  assert.ok(r.panel.innerHTML.includes("单张最多 8 MB"));
  await r.paste([pastedImage]); await r.click("send");
  assert.equal(r.nodes.get("#chatInput").value, "Keep this question");
  assert.ok(r.panel.innerHTML.includes('data-c="unimage"'));
  await r.click("new");
  assert.equal(r.nodes.get("#chatInput").value, "");
  assert.ok(!r.panel.innerHTML.includes('data-c="unimage"'));
});

test("saved attachments use scoped URLs and malformed image paths are ignored", async () => {
  const image = "chat-media/" + "a".repeat(32) + ".png";
  const r = await reader([{ id: "saved", title: "With image", messages: [{ role: "user", content: "Look", images: [image, "../../config.json", "javascript:alert(1)"] }] }]);
  await r.selectThread("saved");
  assert.ok(r.panel.innerHTML.includes('/p/test/' + image));
  assert.ok(!r.panel.innerHTML.includes("../../config.json"));
  assert.ok(!r.panel.innerHTML.includes("javascript:alert"));
});
