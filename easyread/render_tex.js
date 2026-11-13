// 用与阅读页同一份 KaTeX 批量预渲染 LaTeX 公式为静态 HTML
// 命令行参数：process.argv[2] 为 katex.min.js 的绝对路径
// 输入（stdin）：JSON 数组，格式为 [{"key": "D0", "tex": "...", "display": true}, ...]
// 输出（stdout）：JSON 对象，格式为 {"D0": "<span class=\"katex-display\">...</span>", ...}
const path = require("path");
const katex = require(path.resolve(process.argv[2]));

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let items = [];
  try {
    items = JSON.parse(input || "[]");
  } catch (e) {
    process.stderr.write("Invalid JSON input: " + e.message + "\n");
    process.exit(1);
  }

  const result = {};
  for (const item of items) {
    if (!item || typeof item.tex !== "string") continue;
    const key = item.key || ((item.display ? "D" : "I") + item.tex);
    try {
      result[key] = katex.renderToString(item.tex, {
        displayMode: !!item.display,
        throwOnError: false,
        strict: "ignore",
        trust: false,
      });
    } catch (e) {
      const esc = item.tex
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      result[key] = '<code class="tex-fallback">' + esc + "</code>";
    }
  }

  process.stdout.write(JSON.stringify(result));
});
