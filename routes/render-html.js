/* ======================================================
   Server-side page rendering shared by the PDF and Image routes.

   The editor sends each page's HTML with formulas as EMPTY markers
   (<span class="latex-formula" data-latex="..."></span>) instead of the
   thousands of KaTeX <span>s a rendered formula is made of. That is what
   kept the request under the size limit and the headless browser fast.
   Here every marker is rendered to KaTeX HTML with the katex npm package
   (no browser needed for that), and the KaTeX stylesheet + fonts are
   embedded into the page, so exporting never waits on the internet.
   ====================================================== */
const fs = require("fs");
const path = require("path");
const katex = require("katex");
require("katex/contrib/mhchem"); // \ce{...} chemistry, same as the editor
const WPSMath = require("../public/math-shared.js");

const styleCssPath = path.join(__dirname, "..", "public", "style.css");

let cachedKatexCss = null;
function katexCss() {
    if (cachedKatexCss !== null) return cachedKatexCss;
    try {
        const dist = path.join(path.dirname(require.resolve("katex/package.json")), "dist");
        let css = fs.readFileSync(path.join(dist, "katex.min.css"), "utf8");
        // keep only the woff2 source of each font, inlined as a data: URI
        css = css.replace(/src:\s*([^;}]*)/g, function (whole, list) {
            const m = list.match(/url\((?:"|')?fonts\/([^)"']+\.woff2)(?:"|')?\)/);
            if (!m) return whole;
            const file = path.join(dist, "fonts", m[1]);
            if (!fs.existsSync(file)) return whole;
            const b64 = fs.readFileSync(file).toString("base64");
            return 'src:url("data:font/woff2;base64,' + b64 + '") format("woff2")';
        });
        cachedKatexCss = css;
    } catch (e) {
        console.error("KaTeX CSS could not be inlined:", e.message);
        cachedKatexCss = "";
    }
    return cachedKatexCss;
}

let cachedStyleCss = null;
function styleCss() {
    if (cachedStyleCss !== null) return cachedStyleCss;
    try {
        cachedStyleCss = fs.readFileSync(styleCssPath, "utf8");
    } catch (e) {
        cachedStyleCss = ""; // style.css missing — export still works, just unstyled
    }
    return cachedStyleCss;
}

function decodeAttr(v) {
    return v
        .replace(/&nbsp;/g, "\u00a0")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&");
}

function renderOne(latex, display) {
    try {
        return katex.renderToString(WPSMath.prepareLatex(latex), {
            throwOnError: false,
            displayMode: !!display,
            macros: Object.assign({}, WPSMath.MACROS),
            strict: "ignore",
            output: "html" // the visual copy only — the hidden MathML copy just doubles the size
        });
    } catch (e) {
        return escapeText(latex);
    }
}

function escapeText(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// <span class="latex-formula" data-latex=".." [data-display="1"] [data-wrapped="1"]></span>
const MARKER_RE = /<span class="latex-formula"((?:\s+[a-zA-Z-]+="[^"]*")*)\s*>(?:<\/span>)/g;

function renderFormulas(html) {
    return html.replace(MARKER_RE, function (whole, attrs) {
        const get = (name) => {
            const m = new RegExp("\\s" + name + '="([^"]*)"').exec(attrs);
            return m ? decodeAttr(m[1]) : null;
        };
        const latex = get("data-latex");
        if (latex === null) return whole;
        const display = get("data-display") === "1";
        const wrapped = get("data-wrapped") === "1";
        const cls = 'class="latex-formula"' + (display ? ' data-display="1"' : "") + (wrapped ? ' data-wrapped="1"' : "");

        if (wrapped) {
            const chunks = WPSMath.splitLatexAtCommas(latex);
            if (chunks) {
                const parts = chunks.map((c) => '<span class="lf-part">' + renderOne(c, false) + "</span>").join("<wbr>");
                return "<span " + cls + ">" + parts + "</span>";
            }
        }
        return "<span " + cls + ">" + renderOne(latex, display) + "</span>";
    });
}

const BASE_CSS =
    "body, .page { font-family: 'Noto Sans', 'Noto Sans Devanagari', sans-serif !important; }\n" +
    "body { background: #fff; margin: 0; padding: 0; }\n" +
    // nothing on the page needs the network any more; also stops any
    // stray external font/image request from holding the export up
    "";

function documentShell(bodyHtml, cssVars, extraCss) {
    return (
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"UTF-8\">\n" +
        "<style>" + katexCss() + "</style>\n" +
        "<style>" + styleCss() + "</style>\n" +
        "<style>" + BASE_CSS + (extraCss || "") + "</style>\n" +
        "<style>:root{" + (cssVars || "") + "}</style>\n" +
        "</head>\n<body>\n" + bodyHtml + "\n</body>\n</html>"
    );
}

// Only one export at a time: each one starts a full Chromium, and on a
// small (512 MB) instance two at once can run it out of memory.
let chain = Promise.resolve();
function exclusive(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
}

const LAUNCH_ARGS = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-extensions",
    "--font-render-hinting=none"
];

module.exports = { renderFormulas, documentShell, exclusive, LAUNCH_ARGS };
