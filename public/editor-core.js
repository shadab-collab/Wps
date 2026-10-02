/* ======================================================
   EDITOR CORE — editor-core.js
   Formatting, margins, smart paste (Markdown headings/bold/
   lists/tables), KaTeX math rendering, and image insert/resize.

   This file is intentionally the "stable" layer that shouldn't
   need to change when the pagination/column engine is rewritten.
   It talks to pagination.js only through window.WPSEditor, never
   through shared closure variables, so the two files can be
   edited independently.
   ====================================================== */

(function () {
    "use strict";

    window.WPSEditor = window.WPSEditor || {};

    /* ------------------------------------------------
       STATE
    ------------------------------------------------ */
    let autoRenderEnabled = true;

    /* ------------------------------------------------
       UTIL
    ------------------------------------------------ */
    function closestPage(node) {
        let n = node && node.nodeType === 3 ? node.parentElement : node;
        while (n && (!n.classList || !n.classList.contains("page"))) n = n.parentElement;
        return n;
    }

    function allPages() {
        return Array.from(document.querySelectorAll(".page"));
    }

    /* ==================================================
       1. TEXT FORMATTING
    ================================================== */
    window.formatDoc = function (command, value) {
        document.execCommand(command, false, value || null);
    };

    /* ==================================================
       2. FONT SIZE / LINE SPACING / MARGINS
    ================================================== */

    // Tapping the font-size input steals focus from the page, which
    // clears the browser's text selection before updateFontSize() ever
    // runs. So instead of relying on the live selection at that point,
    // we continuously remember the last real (non-collapsed) selection
    // made inside a page, and use that instead.
    let lastPageSelectionRange = null;

    document.addEventListener("selectionchange", () => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        if (closestPage(range.startContainer)) {
            lastPageSelectionRange = range.cloneRange();
        }
    });

    // Wraps the remembered selection in a <span style="font-size:...">.
    // Returns false (does nothing) if there's no usable remembered
    // selection, so the caller can fall back to changing the whole
    // document's default size instead.
    function applyFontSizeToSelection(sizePt) {
        const range = lastPageSelectionRange;
        if (!range || range.collapsed) return false;
        if (!document.contains(range.startContainer)) return false; // stale — page changed since
        if (!closestPage(range.startContainer)) return false;

        const span = document.createElement("span");
        span.style.fontSize = sizePt + "pt";
        try {
            range.surroundContents(span);
        } catch (e) {
            // selection spans multiple elements (surroundContents can't
            // handle that) — extract + wrap instead, which handles any
            // selection shape
            const contents = range.extractContents();
            span.appendChild(contents);
            range.insertNode(span);
        }

        const newRange = document.createRange();
        newRange.selectNodeContents(span);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(newRange);
        lastPageSelectionRange = null; // consumed — don't reapply it next time
        return true;
    }

    window.updateFontSize = function () {
        const val = document.getElementById("font-size-input").value;
        const appliedToSelection = applyFontSizeToSelection(val);
        if (!appliedToSelection) {
            document.documentElement.style.setProperty("--font-size", val + "pt");
        }
        window.WPSEditor.scheduleRepagination();
    };

    window.updateLineSpacing = function () {
        const val = document.getElementById("line-height-input").value;
        document.documentElement.style.setProperty("--line-height", val);
        window.WPSEditor.scheduleRepagination();
    };

    window.updateMargins = function () {
        const map = {
            "top-margin": "--top-margin",
            "bottom-margin": "--bottom-margin",
            "inside-margin": "--inside-margin",
            "outside-margin": "--outside-margin",
            "gutter-margin": "--gutter-margin",
            "column-gap-margin": "--column-gap"
        };
        Object.keys(map).forEach((id) => {
            const input = document.getElementById(id);
            if (input) document.documentElement.style.setProperty(map[id], input.value + "mm");
        });
        window.WPSEditor.scheduleRepagination();
    };

    /* ==================================================
       3. CARET PRESERVATION
       (Handled directly inside repaginateAll below, since that
       process is now asynchronous/chunked — the caret is saved
       once up front and restored once at the very end.)
    ================================================== */

    /* ==================================================
       4. SMART PASTE
       Raw newlines under white-space:pre-wrap combined with
       break-inside:avoid paragraphs can force an empty paragraph
       to jump to the next column, leaving the rest of the current
       column blank. Fix: rebuild pasted text as clean <p> blocks
       and collapse runs of blank lines instead of keeping them.
    ================================================== */
    // Minimal Markdown support so text pasted from AI chats (###
    // headings, **bold**, *italic*) renders instead of showing the
    // raw symbols. Escaping happens first, formatting after, so
    // "<" / "&" in the source can never break the HTML we build.
    function escapeHtml(str) {
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    // AI apps (Gemini in particular) pad blank spacing lines with
    // invisible characters — zero-width space/joiner, BOM — instead of
    // a truly empty line. A plain .trim() does NOT strip these, so a
    // "blank" line like this slips past the empty-line check and turns
    // into a visible empty paragraph. Strip them before testing/using
    // any line for blankness.
    const INVISIBLE_CHARS = /[\u200B\u200C\u200D\uFEFF\u00A0\u2060\u180E\u2000-\u200A\u3000]/g;
    function stripInvisible(str) {
        return str.replace(INVISIBLE_CHARS, "");
    }
    function isBlank(str) {
        return stripInvisible(str).trim() === "";
    }

    // A line that's just a bare "[" or "]" with nothing else is almost
    // always a leftover display-math delimiter — the source meant LaTeX
    // "\[ ... \]" but the backslashes were stripped somewhere along the
    // way (common with plain-text copies from AI chats), leaving these
    // orphaned brackets sitting on their own line around the formula.
    // Treated as blank so they don't show up as a stray floating
    // "[" / "]" line above/below the (now correctly rendering) formula.
    function isStrayMathBracketLine(str) {
        return stripInvisible(str).trim() === "[" || stripInvisible(str).trim() === "]";
    }

    // Math ($...$ / $$...$$) is set aside BEFORE the Markdown pass and
    // restored afterwards, so a "*" or "_" inside a formula (2^*, x_1 + y_1)
    // can never be mistaken for bold/italic markup.
    function inlineMarkdown(text) {
        const saved = [];
        const shielded = text.replace(/\$\$[^$]+\$\$|\$[^$\n]+\$/g, function (m) {
            saved.push(m);
            return "\u0007" + (saved.length - 1) + "\u0008";
        });
        let out = escapeHtml(shielded);
        out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
        out = out.replace(/\*(.+?)\*/g, "<i>$1</i>");
        out = out.replace(/(^|[^\w])_(.+?)_([^\w]|$)/g, "$1<i>$2</i>$3");
        return out.replace(/\u0007(\d+)\u0008/g, function (m, i) {
            return escapeHtml(saved[Number(i)]);
        });
    }

    /* ------------------------------------------------
       MATH DELIMITER NORMALISATION
       NotebookLM / Gemini / ChatGPT write math as \( ... \), \[ ... \]
       — and NotebookLM's plain-text export doubles the backslashes:
       \\( ... \\), \\[ ... \\]. The editor only understands $...$ and
       $$...$$, so everything is converted to that one form here, before
       any other paste processing looks at the text.
    ------------------------------------------------ */
    function fixMathBody(body) {
        let s = body.replace(/\s*\n\s*/g, " ").trim();
        s = s.replace(/\\\\(?=[A-Za-z])/g, "\\");            // "\\text" -> "\text"
        s = s.replace(/<->/g, "\\leftrightarrow ");
        s = s.replace(/(^|[^\\<-])->/g, "$1\\rightarrow ");
        s = s.replace(/(^|[^\\<=])=>/g, "$1\\Rightarrow ");
        return s;
    }

    function normalizeMathDelimiters(text) {
        if (!text || text.indexOf("\\") === -1) return text;
        const NO_BLANK = "((?:(?!\\n[ \\t]*\\n)[\\s\\S])*?)";

        // display: \[ ... \]  /  \\[ ... \\]
        let out = text.replace(new RegExp("\\\\{1,2}\\[" + NO_BLANK + "\\\\{1,2}\\]", "g"), function (m, body, offset, whole) {
            const before = whole.slice(0, offset);
            const after = whole.slice(offset + m.length);
            const prefix = before.slice(before.lastIndexOf("\n") + 1);
            const nl = after.indexOf("\n");
            const suffix = nl === -1 ? after : after.slice(0, nl);
            // Alone on its line it is a real (centred) display equation;
            // anywhere else — inside a sentence, or followed by a source
            // marker like "[2]" — it stays inline so nothing is left
            // hanging on a line by itself.
            const standalone = /^\s*$/.test(prefix) && /^\s*$/.test(suffix);
            const b = fixMathBody(body);
            return standalone ? "$$" + b + "$$" : "$" + b + "$";
        });

        // inline: \( ... \)  /  \\( ... \\)
        out = out.replace(new RegExp("\\\\{1,2}\\(" + NO_BLANK + "\\\\{1,2}\\)", "g"), function (m, body) {
            return "$" + fixMathBody(body) + "$";
        });
        return out;
    }

    // AI chat exports (Gemini/ChatGPT etc.) often write LaTeX commands
    // directly inside a Hindi sentence with no $...$ delimiters at all,
    // e.g. "यदि \theta = 60^\circ तो सिद्ध करें कि...". Our renderer only
    // recognises math that's either a whole pure-LaTeX paragraph or
    // wrapped in $...$, so this scans each line for such raw runs and
    // inserts the missing $...$ around them before anything else touches
    // the line — pure-LaTeX-only lines (no Hindi) are left alone since
    // those already render correctly as a whole block.
    function containsDevanagari(str) {
        return /[\u0900-\u097F]/.test(str);
    }

    function autoWrapLatex(line) {
        if (!containsDevanagari(line)) return line;
        if (!/\\[a-zA-Z]|[A-Za-z0-9][\^_][A-Za-z0-9{]/.test(line)) return line;

        const CONTINUE_CHARS = /[A-Za-z0-9\^_+\-=*/().,!]/;
        const CONTINUE_AFTER_SPACE = /^[A-Za-z0-9\\^_+\-=*/().,!]/;
        let result = "";
        let i = 0;
        const n = line.length;

        while (i < n) {
            const ch = line[i];
            const startsCommand = ch === "\\" && /[A-Za-z]/.test(line[i + 1] || "");
            const startsExponent = /[A-Za-z0-9]/.test(ch) && (line[i + 1] === "^" || line[i + 1] === "_");

            if (startsCommand || startsExponent) {
                let j = i;
                let depth = 0;
                let runEnd = i;
                let sawCommand = false;

                while (j < n) {
                    const c = line[j];
                    if (c === "{") { depth++; j++; runEnd = j; continue; }
                    if (c === "}") { depth = Math.max(0, depth - 1); j++; runEnd = j; continue; }
                    if (depth > 0) { j++; runEnd = j; continue; } // inside {...}: allow anything, incl. Devanagari (\text{सेमी})
                    if (c === "\\" && /[A-Za-z]/.test(line[j + 1] || "")) {
                        sawCommand = true;
                        j++;
                        while (j < n && /[A-Za-z]/.test(line[j])) j++;
                        runEnd = j;
                        continue;
                    }
                    if (CONTINUE_CHARS.test(c)) { j++; runEnd = j; continue; }
                    if (c === " ") {
                        const rest = line.slice(j + 1);
                        if (CONTINUE_AFTER_SPACE.test(rest)) { j++; runEnd = j; continue; }
                        break;
                    }
                    break;
                }

                const run = line.slice(i, runEnd);
                if (runEnd > i && (sawCommand || /[A-Za-z0-9][\^_]/.test(run))) {
                    result += "$" + run.trim() + "$";
                    i = runEnd;
                    continue;
                }
            }

            result += ch;
            i++;
        }
        return result;
    }

    // Only ever called for lines that are NOT list bullets — those are
    // intercepted earlier in cleanPasteToParagraphs so a run of them
    // can be grouped into one shared <ol>/<ul> instead of being decided
    // line-by-line here.
    function markdownLineToHtml(line) {
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            const level = Math.min(heading[1].length, 6);
            return "<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">";
        }
        return "<p>" + inlineMarkdown(line) + "</p>";
    }

    // A markdown table row looks like "| cell | cell |". The row right
    // after the header is a separator made only of dashes/colons/pipes
    // (e.g. "| :--- | :--- |") and carries no content — it just marks
    // where the header ends, so we detect and skip it.
    function isTableRow(line) {
        return /^\|.*\|$/.test(line.trim());
    }
    function isTableSeparatorRow(line) {
        return /^\|[\s:\-|]+\|$/.test(line.trim());
    }
    function splitTableCells(line) {
        const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
        return trimmed.split("|").map((c) => c.trim());
    }
    function tableRowsToHtml(rows) {
        let html = "<table>";
        rows.forEach((cells, i) => {
            const tag = i === 0 ? "th" : "td";
            html += "<tr>" + cells.map((c) => "<" + tag + ">" + inlineMarkdown(c) + "</" + tag + ">").join("") + "</tr>";
        });
        html += "</table>";
        return html;
    }

    function cleanPasteToParagraphs(text) {
        const lines = normalizeMathDelimiters(text.replace(/\r\n/g, "\n")).split("\n");
        const htmlParts = [];
        let listType = null; // "ul"/"ol" currently being collected, or null
        let listItems = []; // inline content (no <li> wrapper) collected so far

        function flushList() {
            if (!listType) return;
            if (listItems.length === 1) {
                // A "list" of exactly one item is almost always a
                // numbered/dashed line of plain text immediately
                // followed by unrelated text (e.g. "1. सवाल" then
                // "उत्तर: ..." on the next line, which isn't a bullet)
                // rather than a real list. Rendering it as its own
                // one-item <ol>/<ul> would always show "1." no matter
                // what digit was in the source — each separate <ol>
                // restarts its own numbering — so treat it as a plain
                // paragraph instead, matching how it actually reads.
                // Keep the original marker text ("1.", "-"...) visible
                // in that paragraph — dropping it entirely would make
                // the number disappear rather than just stop being a
                // "real" list, which reads as data loss to the user.
                htmlParts.push("<p>" + escapeHtml(listItems[0].marker) + " " + listItems[0].html + "</p>");
            } else {
                // A numbered run's first marker (e.g. "6." for a
                // continuation list picking up after page 4's "1."-"5.")
                // carries where the real numbering should start — an
                // <ol> defaults to 1 otherwise, which is exactly the
                // "renumbers back to 1" bug this avoids. Only relevant
                // for "ol"; "ul" bullets have no numbering to preserve.
                let openTag = "<" + listType;
                if (listType === "ol") {
                    const firstNum = parseInt(listItems[0].marker, 10);
                    if (firstNum && firstNum !== 1) openTag += ' start="' + firstNum + '"';
                }
                htmlParts.push(
                    openTag +
                        ">" +
                        listItems.map((it) => "<li>" + it.html + "</li>").join("") +
                        "</" +
                        listType +
                        ">"
                );
            }
            listType = null;
            listItems = [];
        }

        let i = 0;
        while (i < lines.length) {
            // Note: blankness is checked with invisible chars stripped
            // (isBlank), but the line content used below keeps them —
            // Devanagari text can legitimately rely on zero-width
            // joiner/non-joiner for correct conjunct rendering, so we
            // must not strip those from real (non-blank) lines.
            if (isBlank(lines[i]) || isStrayMathBracketLine(lines[i])) { i++; continue; } // drop blank lines (incl. invisible-char-only) and orphaned "\[...\]" delimiter brackets
            const trimmed = lines[i].trim();

            // "---" / "***" on its own line is a divider, not text.
            if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
                flushList();
                htmlParts.push("<hr>");
                i++;
                continue;
            }

            // An indented line right under a list item is that item's own
            // second line (e.g. the answer under a numbered question) —
            // keep it inside the item as a line break instead of turning
            // it into a separate paragraph. This is also how a <br> inside
            // an item survives the double-tap / auto-normalise round trip.
            if (
                listType && listItems.length &&
                /^(?: {2,}|\t)\S/.test(lines[i]) &&
                !isTableRow(trimmed) &&
                !/^([-*]|\d+[.)])\s+/.test(trimmed)
            ) {
                listItems[listItems.length - 1].html += "<br>" + inlineMarkdown(trimmed);
                i++;
                continue;
            }

            if (isTableRow(trimmed)) {
                flushList();
                const rows = [];
                while (i < lines.length && isTableRow(lines[i].trim())) {
                    const rowLine = lines[i].trim();
                    if (!isTableSeparatorRow(rowLine)) rows.push(splitTableCells(rowLine));
                    i++;
                }
                if (rows.length) htmlParts.push(tableRowsToHtml(rows));
                continue;
            }

            // "- item"/"* item" is unordered; "1. item"/"1) item" is
            // numbered — collected separately so a run of numbered
            // lines round-trips back to a real <ol>, not bullets.
            const ulMatch = trimmed.match(/^([-*])\s+(.*)$/);
            const olMatch = !ulMatch && trimmed.match(/^(\d+[.)])\s+(.*)$/);
            const bulletMatch = ulMatch || olMatch;

            if (bulletMatch) {
                const marker = bulletMatch[1];
                const content = bulletMatch[2];
                if (isBlank(content)) { i++; continue; } // bullet marker with no real text — drop it
                const thisType = ulMatch ? "ul" : "ol";
                if (listType && listType !== thisType) flushList();
                listType = thisType;
                listItems.push({ marker: marker, html: inlineMarkdown(content) });
                i++;
                continue;
            }

            flushList();
            htmlParts.push(markdownLineToHtml(trimmed));
            i++;
        }
        flushList();
        return htmlParts.join("");
    }

    // Clipboard "rich" HTML (from copying inside an app like Gemini,
    // where bold/headings are real formatting, not markdown symbols)
    // carries the actual <b>/<h2>/<ul> structure — but also a lot of
    // source-app styling (fonts, colors, spans) we don't want. This
    // keeps only the semantic tags we care about and drops the rest,
    // unwrapping anything unrecognised rather than losing its text.
    /* ------------------------------------------------
       LINE BREAKS THAT THE RICH-TEXT FLAVOUR LOSES
       A chat app shows "question" and "उत्तर: ..." on two lines, but the
       copied HTML can carry that break only as a bare newline (shown via
       white-space:pre-wrap) — which HTML collapses to a space, gluing both
       onto one line. Two safeguards, neither of which depends on any
       particular word:
         1. a newline inside text whose source styling preserves
            whitespace is kept as a real line break;
         2. the plain-text flavour of the SAME clipboard shows exactly
            where lines were broken (an indented continuation line), so a
            break is put back wherever that same line-start text sits
            glued to the end of a sentence in the HTML.
    ------------------------------------------------ */
    function preservesNewlines(textNode, root) {
        for (let a = textNode.parentElement; a && a !== root; a = a.parentElement) {
            const st = a.getAttribute && a.getAttribute("style");
            if (!st) continue;
            const m = /white-space\s*:\s*([a-z-]+)/i.exec(st);
            if (m) return /^(pre|pre-wrap|pre-line|break-spaces)$/i.test(m[1]);
        }
        return false;
    }

    // Start-of-line snippets (first words) of every line in the plain-text
    // flavour that directly follows another non-blank line — i.e. where
    // the source broke a line WITHOUT starting a new paragraph (the
    // "उत्तर: ..." under its question, indented or not). Bullet / number
    // markers are skipped: those are separate list items in HTML anyway.
    function continuationStarts(plain) {
        const map = new Map(); // first word -> [snippets]
        if (!plain) return map;
        const lines = plain.replace(/\r\n/g, "\n").split("\n");
        let count = 0;
        for (let i = 1; i < lines.length && count < 4000; i++) {
            const line = lines[i].trim();
            if (!line || !lines[i - 1].trim()) continue;
            if (/^([-*•]|\d+[.)])\s/.test(line)) continue;
            const snip = line.split(/\s+/).slice(0, 3).join(" ").split(/[\\$\{]/)[0].trim().slice(0, 24);
            if (snip.length < 3 || !/^[A-Za-z\u0900-\u097F]/.test(snip)) continue;
            const first = snip.split(/\s+/)[0];
            if (!map.has(first)) map.set(first, []);
            const arr = map.get(first);
            if (arr.indexOf(snip) === -1) { arr.push(snip); count++; }
        }
        return map;
    }

    const INLINE_WRAPPERS = /^(B|STRONG|I|EM|U|SPAN|FONT|A|SUB|SUP)$/;

    // The inline content that sits right before `node` in the same block,
    // looking out through bold/italic wrappers ("<b>उत्तर:</b>" starts
    // inside its <b>, but what precedes it is the question next to the <b>).
    function precedingInline(node) {
        let cur = node;
        while (cur) {
            let prev = cur.previousSibling;
            while (prev && prev.nodeType === 3 && !prev.nodeValue.trim()) prev = prev.previousSibling;
            if (prev) return { prev: prev, top: cur };
            const par = cur.parentNode;
            if (!par || !INLINE_WRAPPERS.test(par.nodeName)) return null;
            cur = par;
        }
        return null;
    }

    function restoreLineBreaks(htmlString, plain) {
        const starts = continuationStarts(plain);
        if (!starts.size) return htmlString;
        const box = document.createElement("div");
        box.innerHTML = htmlString;
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let n;
        while ((n = walker.nextNode())) nodes.push(n);

        // first position in `text` where a known line-start snippet sits
        // glued to what came before it (or -1)
        function findGlued(node, text) {
            const re = /\S+/g;
            let m;
            while ((m = re.exec(text)) !== null) {
                const list = starts.get(m[0]);
                if (!list) continue;
                const k = m.index;
                const snip = list.find((sn) => text.startsWith(sn, k));
                if (!snip) continue;
                const before = text.slice(0, k);
                if (before.trim()) {
                    // text before it in the same node: a sentence end, or a
                    // snippet long enough to be unmistakably a line start
                    if (/[।.?!:;)\]]\s*$/.test(before) || snip.length >= 10) return k;
                } else {
                    const info = precedingInline(node);
                    if (info && info.prev.nodeName !== "BR") return k;
                }
            }
            return -1;
        }

        nodes.forEach((node0) => {
            if (!node0.parentElement || !node0.parentElement.closest("li, p, td, th")) return;
            let node = node0;
            for (let guard = 0; guard < 60; guard++) {
                const text = node.nodeValue;
                const k = findGlued(node, text);
                if (k === -1) break;
                const br = document.createElement("br");
                const before = text.slice(0, k);
                if (before.trim()) {
                    const parent = node.parentNode;
                    parent.insertBefore(document.createTextNode(before.replace(/\s+$/, "")), node);
                    parent.insertBefore(br, node);
                    node.nodeValue = text.slice(k);
                } else {
                    const info = precedingInline(node);
                    info.top.parentNode.insertBefore(br, info.top);
                    node.nodeValue = text.replace(/^\s+/, "");
                    break; // the rest of this node is already past its line start
                }
            }
        });
        return box.innerHTML;
    }

    function sanitizePastedHtml(rawHtml, plainText) {
        const temp = document.createElement("div");
        temp.innerHTML = rawHtml;
        temp.querySelectorAll("script, style, meta, link, noscript, template").forEach((el) => el.remove());

        // Some apps encode bold/italic as inline CSS on a <span>/<font>
        // wrapper instead of using <b>/<strong>/<i>/<em> tags — this
        // catches that before the wrapper gets unwrapped away below.
        function applyInlineStyleWrap(node, inner) {
            const style = node.getAttribute && node.getAttribute("style");
            if (!style) return inner;
            const fw = /font-weight\s*:\s*(\d+|bold)/i.exec(style);
            const isBold = fw && (fw[1].toLowerCase() === "bold" || parseInt(fw[1], 10) >= 600);
            const isItalic = /font-style\s*:\s*italic/i.test(style);
            if (isBold) inner = "<b>" + inner + "</b>";
            if (isItalic) inner = "<i>" + inner + "</i>";
            return inner;
        }

        // Gemini / NotebookLM / ChatGPT copy their formulas as rendered
        // KaTeX markup: a hidden MathML copy (with the ORIGINAL LaTeX in an
        // <annotation>) plus dozens of visual glyph <span>s. Reading the
        // text of all that is what produced "A", "=", "{", "1" ... one per
        // line, followed by the formula a second time. The only thing worth
        // keeping is the annotation — the real LaTeX source.
        function texFromMathNode(node) {
            const dm = node.getAttribute && node.getAttribute("data-math");
            if (dm) return dm;
            const ann = node.querySelector && node.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="application/x-latex"]');
            if (ann && ann.textContent) return ann.textContent;
            return null;
        }

        function mathToken(tex, display) {
            const body = fixMathBody(tex);
            if (!body) return "";
            return (display ? "$$" : "$") + escapeHtml(body) + (display ? "$$" : "$");
        }

        function cleanNode(node) {
            if (node.nodeType === 3) {
                // HTML collapses newlines/tabs inside text into a single space,
                // but the page uses white-space:pre-wrap, where a stray "\n"
                // would show up as a real blank line — so collapse them here.
                if (/\n/.test(node.nodeValue) && /\S/.test(node.nodeValue) && preservesNewlines(node, temp)) {
                    return node.nodeValue
                        .split("\n")
                        .map((part) => escapeHtml(normalizeMathDelimiters(part).replace(/[ \t\r\f]+/g, " ").trim()))
                        .filter((part, i, arr) => part || (i > 0 && i < arr.length - 1))
                        .join("<br>");
                }
                return escapeHtml(normalizeMathDelimiters(node.nodeValue).replace(/[ \t\r\n\f]+/g, " "));
            }
            if (node.nodeType !== 1) return "";

            const tag = node.tagName.toLowerCase();
            const cls = (node.getAttribute("class") || "");

            // ---- math first: never walk into the glyph spans ----
            if (/(^|\s)katex-display(\s|$)/.test(cls) || /(^|\s)(math-block|math-display)(\s|$)/.test(cls)) {
                const tex = texFromMathNode(node);
                if (tex) return mathToken(tex, true);
            }
            if (/(^|\s)(katex|math-inline)(\s|$)/.test(cls) || node.hasAttribute("data-math") || tag === "math") {
                const tex = texFromMathNode(node);
                if (tex) {
                    const display = /(^|\s)math-block(\s|$)/.test(cls) || node.getAttribute("display") === "block";
                    return mathToken(tex, display);
                }
                if (/(^|\s)katex(\s|$)/.test(cls)) return ""; // rendered KaTeX with no source at all — nothing usable
            }
            if (/(^|\s)(katex-html|katex-mathml)(\s|$)/.test(cls)) return "";

            const inner = Array.from(node.childNodes).map(cleanNode).join("");

            if (/^h[1-6]$/.test(tag)) return "<" + tag + ">" + inner.trim() + "</" + tag + ">";
            if (tag === "b" || tag === "strong") return "<b>" + inner + "</b>";
            if (tag === "i" || tag === "em") return "<i>" + inner + "</i>";
            if (tag === "u") return "<u>" + inner + "</u>";
            if (tag === "ul") return "<ul>" + inner + "</ul>";
            if (tag === "ol") return "<ol>" + inner + "</ol>";
            if (tag === "li") {
                let wrapped = applyInlineStyleWrap(node, inner).trim();
                // Gemini wraps each line of an item in its own <p>
                // ("question" / "उत्तर:"). Inside an item that is just a
                // line break — turning it into <br> keeps the item's lines
                // tight and identical to how a plain-text paste is built.
                wrapped = wrapped.replace(/<\/p>\s*<p>/gi, "<br>").replace(/^<p>/i, "").replace(/<\/p>$/i, "");
                // Same reasoning as <p> above: a list item that Gemini
                // padded with only an invisible character/<br> is not
                // a real bullet — drop it instead of rendering an
                // empty "•" line.
                const noBreaks = wrapped.replace(/<br\s*\/?>/gi, "");
                if (isBlank(noBreaks)) return "";
                return "<li>" + wrapped + "</li>";
            }
            if (tag === "table") return "<table>" + inner + "</table>";
            if (tag === "tr") return "<tr>" + inner + "</tr>";
            if (tag === "td") return "<td>" + applyInlineStyleWrap(node, inner).trim() + "</td>";
            if (tag === "th") return "<th>" + applyInlineStyleWrap(node, inner).trim() + "</th>";
            if (tag === "hr") return "<hr>";
            if (tag === "p" || tag === "div") {
                const wrapped = applyInlineStyleWrap(node, inner).trim();
                // Apps like Gemini insert a blank <p></p> (or a <p>
                // holding only a stray <br>) between sections purely as
                // spacing — that becomes a visible empty line once our
                // CSS adds its own paragraph margin on top. Drop any
                // paragraph with no real text/content instead of
                // keeping it, so spacing comes only from our CSS.
                const noBreaks = wrapped.replace(/<br\s*\/?>/gi, "");
                if (isBlank(noBreaks)) return "";
                return "<p>" + wrapped + "</p>";
            }
            if (tag === "br") return "<br>";
            // span/font/style-only wrappers etc. — check for bold/italic
            // via inline style, then unwrap, keeping the text/children
            return applyInlineStyleWrap(node, inner);
        }

        let out = Array.from(temp.childNodes).map(cleanNode).join("").trim();
        // Whitespace sitting BETWEEN block tags ("</li> <li>") is layout
        // noise from the source app; under pre-wrap it would render as
        // extra blank lines between every list item / paragraph.
        const BLOCK = "(?:ul|ol|li|table|thead|tbody|tr|td|th|p|h[1-6]|hr)";
        out = out.replace(new RegExp("(</?" + BLOCK + "(?:\\s[^>]*)?>)\\s+(?=</?" + BLOCK + "[\\s>])", "gi"), "$1");
        // Collapse any run of consecutive <br> (line breaks sitting
        // directly between block tags, not inside a paragraph) down to
        // one, and drop empty list items the same way as paragraphs.
        out = out.replace(/(?:\s*<br>\s*){2,}/gi, "<br>");
        out = out.replace(/<li>\s*<\/li>/gi, "");
        if (out && plainText) out = restoreLineBreaks(out, plainText);
        return out || null;
    }

    function handlePaste(e) {
        e.preventDefault();
        const cd = e.clipboardData || window.clipboardData;
        const rawHtml = cd.getData("text/html");
        const text = cd.getData("text/plain");

        let html = rawHtml ? sanitizePastedHtml(rawHtml, text) : null;
        if (!html) {
            if (!text) return;
            html = cleanPasteToParagraphs(text) || "<p></p>";
        }

        document.execCommand("insertHTML", false, html);
        armPasteRender();
        const page = closestPage(e.target);
        if (page) {
            // Same tight, no-stray-blank-line cleanup the "खाली पंक्ति
            // हटाएँ" button does — applied automatically right after
            // paste too, not only when the user presses that button.
            if (window.WPSEditor.cleanBlankLinesInPage) window.WPSEditor.cleanBlankLinesInPage(page);
            window.WPSEditor.scheduleForPage(page);
        }
    }

    /* ==================================================
       5. AUTO MATH RENDERING (KaTeX)
    ================================================== */
    function initRenderStatusToggle() {
        const status = document.getElementById("render-status");
        if (!status) return;
        status.style.cursor = "pointer";
        status.addEventListener("click", () => {
            autoRenderEnabled = !autoRenderEnabled;
            status.textContent = autoRenderEnabled ? "🟢 Auto Render ON" : "🔴 Auto Render OFF";
            if (autoRenderEnabled) allPages().forEach(renderMathInPage);
        });
    }

    function isPureLatex(text) {
        if (!text || text.indexOf("\\") === -1) return false;
        return /^[\\{}A-Za-z0-9+\-=_^().,\/\[\]\s*<>|:;'"!%~]*$/.test(text);
    }

    function safeKatexRender(source, target, displayMode) {
        try {
            window.katex.render(window.WPSMath.prepareLatex(source), target, {
                throwOnError: false,
                displayMode: displayMode,
                macros: window.WPSMath.MACROS
            });
        } catch (e) {
            target.textContent = source;
        }
    }

    // Once caret leaves the block being hand-edited, re-render its
    // math automatically. Without this, a formula you tapped open
    // stayed as raw text forever after tapping elsewhere.
    function watchForBlockExit(page, block) {
        function check() {
            const sel = window.getSelection();
            const stillInside = sel.rangeCount > 0 && block.isConnected && block.contains(sel.getRangeAt(0).startContainer);
            if (!stillInside) {
                document.removeEventListener("selectionchange", check);
                if (autoRenderEnabled) renderMathInPage(page);
            }
        }
        document.addEventListener("selectionchange", check);
    }

    // Clicking a rendered formula turns it back into raw editable
    // text and places the caret at the end of it.
    // Listener attachment is tracked in-memory (not via a DOM attribute)
    // on purpose: a DOM attribute would get saved into the document's
    // HTML and survive a save/reload, wrongly telling us "this formula
    // already has its click listener" for a freshly-parsed element that
    // in fact has none — which is exactly what made every formula in a
    // reloaded saved document permanently un-editable.
    const formulaToggleAttached = new WeakSet();

    function attachEditToggle(span) {
        if (formulaToggleAttached.has(span)) return;
        formulaToggleAttached.add(span);
        span.addEventListener("click", function (e) {
            e.stopPropagation();
            const raw = span.getAttribute("data-latex") || "";
            const wrapMark = span.getAttribute("data-display") === "1" ? "$$" : "$";
            const textNode = document.createTextNode(wrapMark + raw + wrapMark);
            span.replaceWith(textNode);

            const range = document.createRange();
            range.selectNodeContents(textNode);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            const page = closestPage(textNode);
            if (page) page.focus({ preventScroll: true });

            let block = textNode.parentElement;
            while (block && block.parentElement !== page) block = block.parentElement;
            if (block) watchForBlockExit(page, block);
        });
    }

    // One place that builds a rendered formula element, so every path
    // (pasted $..$, $$..$$, whole-line LaTeX, naked LaTeX) produces the
    // same DOM: <span class="latex-formula" data-latex=".." [data-display]>.
    function makeFormulaSpan(latex, display) {
        const span = document.createElement("span");
        span.className = "latex-formula";
        span.setAttribute("data-latex", latex);
        if (display) span.setAttribute("data-display", "1");
        safeKatexRender(latex, span, !!display);
        attachEditToggle(span);
        return span;
    }

    // A line that starts with an option / item label — "(a)", "(iii)",
    // "7(i)", "3." — followed by a formula. The label stays ordinary text
    // and the formula is inline, so it sits left-aligned like the rest of
    // the page instead of being centred as a display equation.
    const LABEL_PREFIX_RE = /^((?:\(\s*[A-Za-z]{1,4}\s*\)|[A-Za-z]{1,4}\s*\)|\d{1,3}\s*(?:[.)]|\(\s*[A-Za-z]{1,4}\s*\)))\s+)(\S[\s\S]*)$/;

    function renderBlockMath(el, raw) {
        const host = el.tagName;
        const label = LABEL_PREFIX_RE.exec(raw);
        el.textContent = "";
        if (label) {
            el.appendChild(document.createTextNode(label[1]));
            el.appendChild(makeFormulaSpan(label[2], false));
            return;
        }
        // Inside a list item or table cell a whole-cell formula is just
        // inline content; only a free-standing paragraph gets centred.
        const display = !(host === "LI" || host === "TD" || host === "TH");
        el.appendChild(makeFormulaSpan(raw, display));
    }

    // $...$  → inline formula      $$...$$ → display (centred) formula
    const DOLLAR_MATH_RE = /\$\$([^$]+)\$\$|\$([^$]+)\$/g;

    function renderInlineMath(el) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (!node.nodeValue || node.nodeValue.indexOf("$") === -1) return NodeFilter.FILTER_REJECT;
                if (node.parentElement && node.parentElement.closest(".latex-formula")) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const targets = [];
        let node;
        while ((node = walker.nextNode())) targets.push(node);

        targets.forEach((textNode) => {
            const text = textNode.nodeValue;
            DOLLAR_MATH_RE.lastIndex = 0;
            let match, lastIndex = 0, found = false;
            const frag = document.createDocumentFragment();

            while ((match = DOLLAR_MATH_RE.exec(text)) !== null) {
                found = true;
                if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                const display = match[1] !== undefined;
                frag.appendChild(makeFormulaSpan((display ? match[1] : match[2]).trim(), display));
                lastIndex = DOLLAR_MATH_RE.lastIndex;
            }

            if (found) {
                if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
                textNode.parentNode.replaceChild(frag, textNode);
            }
        });
    }

    /* ------------------------------------------------
       LONG FORMULAS
       KaTeX never breaks a formula by itself, so a long set such as
       {(-1,-1,-1),(-1,-1,1), ...} runs straight out of its column into
       the next one. When a rendered formula is wider than the block that
       holds it, it is re-rendered as several pieces cut at top-level
       commas, with a line-break opportunity between the pieces.
    ------------------------------------------------ */
    const splitLatexAtCommas = window.WPSMath.splitLatexAtCommas;

    function formulaOverflows(span) {
        if (span.getAttribute("data-display") === "1") {
            return span.scrollWidth > span.clientWidth + 1;
        }
        const host = span.closest("p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, div");
        if (!host) return false;
        const r = span.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        return r.width > 0 && r.right > h.right + 1.5;
    }

    function wrapOverflowingFormulas(page) {
        const spans = Array.from(page.querySelectorAll(".latex-formula")).filter(
            (sp) => sp.getAttribute("data-wrapped") !== "1" && sp.getAttribute("data-wrap-checked") !== "1"
        );
        if (!spans.length) return;
        // read all measurements first (one layout), then write
        const tooWide = spans.filter(formulaOverflows);
        spans.forEach((sp) => sp.setAttribute("data-wrap-checked", "1"));
        tooWide.forEach((sp) => {
            const latex = sp.getAttribute("data-latex") || "";
            const chunks = splitLatexAtCommas(latex);
            if (!chunks) return;
            sp.textContent = "";
            chunks.forEach((chunk, i) => {
                const part = document.createElement("span");
                part.className = "lf-part";
                safeKatexRender(chunk, part, false);
                sp.appendChild(part);
                if (i < chunks.length - 1) sp.appendChild(document.createElement("wbr"));
            });
            sp.setAttribute("data-wrapped", "1");
        });
    }

    function appendMathSpan(frag, latex) {
        frag.appendChild(makeFormulaSpan(latex, false));
    }

    // Characters LaTeX commands are normally built from. A run made
    // only of these, sitting inside otherwise-Hindi text, is treated
    // as a math island IF it also contains a backslash command or a
    // ^/_ (so plain numbers/English words aren't wrongly rendered).
    // \u0001\u0002 wrap a \text{} placeholder (see below); \u0005\u0006
    // wrap a whole protected command-run placeholder (see
    // extractDevanagariCommandRuns) — both must stay part of one
    // continuous "safe" run instead of splitBySafety chopping them up
    // at the control characters themselves.
    const LATEX_SAFE_CHAR_RE = /[\\{}A-Za-z0-9+\-=_^().,\/\[\]\s*<>|:;'"!%~\u0001\u0002\u0005\u0006]/;
    function looksLikeMathRun(run) {
        return /\\|[\^_]/.test(run);
    }

    function splitBySafety(text) {
        const runs = [];
        let current = "", currentSafe = null;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            const safe = LATEX_SAFE_CHAR_RE.test(ch);
            if (currentSafe === null) { currentSafe = safe; current = ch; continue; }
            if (safe === currentSafe) { current += ch; }
            else { runs.push({ text: current, safe: currentSafe }); current = ch; currentSafe = safe; }
        }
        if (current) runs.push({ text: current, safe: currentSafe });
        return runs;
    }

    // "\^3" (or "\^{...}") sitting right after a \text{} word — e.g.
    // सेमी^3 meaning सेमी³ — can't go through KaTeX (no Devanagari
    // glyphs there), so render just the exponent as a plain <sup>.
    function consumeLeadingExponent(str) {
        const m = str.match(/^\^(\{[^}]*\}|.)/);
        if (!m) return null;
        let exp = m[1];
        if (exp.charAt(0) === "{" && exp.charAt(exp.length - 1) === "}") exp = exp.slice(1, -1);
        return { sup: exp, restAfter: str.slice(m[0].length) };
    }

    // (shared with the PDF/image backend — see math-shared.js)
    const wrapBareDevanagari = window.WPSMath.wrapBareDevanagari;

    // AI chat exports often splice a Hindi word directly inside a LaTeX
    // command's braces with no \text{} at all — e.g.
    // "\boxed{चाल=\dfrac{दूरी}{समय}}". KaTeX has no Devanagari glyphs in
    // math mode, so those need \text{} — but naively splitting the
    // whole string into "Hindi" vs "math" runs (as splitBySafety below
    // does for ordinary inline prose) tears \boxed{}/\dfrac{}{} apart at
    // every Devanagari boundary and leaves an unbalanced, unrenderable
    // fragment on each side. This scans for a complete command run
    // instead — the command name plus ALL of its immediately-following
    // {...}/[...] argument groups, balanced across any nesting — wraps
    // the Devanagari found INSIDE that run with \text{}, and then
    // protects the WHOLE run behind a \u0005N\u0006 placeholder (pushed
    // into outArray) so the ordinary \text{}-extraction step further
    // down — built for a plain \text{...} annotation sitting on its
    // own in normal prose — can't reach in and re-fragment the very
    // structure just repaired here. The caller renders each protected
    // run as a single, atomic KaTeX call (see appendMathSpan usage in
    // renderNakedLatexInBlock).
    function extractDevanagariCommandRuns(text, outArray) {
        const CONTINUE_CHARS = /[A-Za-z0-9\^_+\-=*/().,!]/;
        let result = "";
        let i = 0;
        const n = text.length;

        while (i < n) {
            const ch = text[i];
            const startsCommand = ch === "\\" && /[A-Za-z]/.test(text[i + 1] || "");

            if (startsCommand) {
                let j = i;
                let depth = 0;
                let runEnd = i;
                let sawBrace = false;

                while (j < n) {
                    const c = text[j];
                    if (c === "{" || c === "[") { depth++; sawBrace = true; j++; runEnd = j; continue; }
                    if (c === "}" || c === "]") { depth = Math.max(0, depth - 1); j++; runEnd = j; continue; }
                    if (depth > 0) { j++; runEnd = j; continue; } // inside braces: anything goes, incl. Devanagari
                    if (c === "\\" && /[A-Za-z]/.test(text[j + 1] || "")) {
                        j++;
                        while (j < n && /[A-Za-z]/.test(text[j])) j++;
                        runEnd = j;
                        continue;
                    }
                    if (CONTINUE_CHARS.test(c)) { j++; runEnd = j; continue; }
                    break;
                }

                const run = text.slice(i, runEnd);
                if (sawBrace && /[\u0900-\u097F]/.test(run)) {
                    outArray.push(wrapBareDevanagari(run));
                    result += "\u0005" + (outArray.length - 1) + "\u0006";
                } else {
                    result += run;
                }
                i = runEnd;
                continue;
            }

            result += ch;
            i++;
        }
        return result;
    }

    // Renders "naked" LaTeX (no $...$ wrapper, e.g. copied from an AI
    // chat) sitting inline inside otherwise-Hindi paragraphs. \text{}
    // arguments are pulled out as plain text instead of being fed to
    // KaTeX, since KaTeX's math fonts have no Devanagari glyphs.
    function renderNakedLatexInBlock(el) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (!node.nodeValue || node.nodeValue.indexOf("\\") === -1 && !/[\^_]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
                if (node.parentElement && node.parentElement.closest(".latex-formula")) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const targets = [];
        let node;
        while ((node = walker.nextNode())) targets.push(node);

        targets.forEach((textNode) => {
            let text = textNode.nodeValue;
            const commandRuns = [];
            text = extractDevanagariCommandRuns(text, commandRuns);

            // \xrightarrow{ऊष्मा}/\xleftarrow{...} reaction-condition labels
            // often contain Hindi, which KaTeX's math font can't render
            // (that's what shows up as red error text). Keep the arrow
            // itself in math with an empty label, and move the label out
            // as a \text{} annotation, which the next step below already
            // knows how to extract as plain HTML text.
            text = text.replace(/\\(x?rightarrow|x?leftarrow)\{([^}]*)\}/g, (m, cmd, label) => {
                const trimmed = label.trim();
                return "\\" + cmd + "{}" + (trimmed ? "\\text{ (" + trimmed + ")}" : "");
            });

            const textSpans = [];
            const withPlaceholders = text.replace(/\\text\{([^}]*)\}/g, (m, inner) => {
                const idx = textSpans.length;
                textSpans.push(inner);
                return "\u0001" + idx + "\u0002";
            });

            const runs = splitBySafety(withPlaceholders);
            const frag = document.createDocumentFragment();
            let changed = false;

            runs.forEach((run) => {
                const piece = run.text;

                // A fully-protected "\boxed{...}"-style run (see
                // extractDevanagariCommandRuns) — render it as ONE
                // atomic KaTeX call exactly as repaired, never letting
                // the \text{}-splitting logic below touch it.
                if (piece.indexOf("\u0005") !== -1) {
                    changed = true;
                    const re = /\u0005(\d+)\u0006/g;
                    let lastIndex = 0, m;
                    while ((m = re.exec(piece)) !== null) {
                        const before = piece.slice(lastIndex, m.index);
                        if (before) frag.appendChild(document.createTextNode(before));
                        appendMathSpan(frag, commandRuns[Number(m[1])]);
                        lastIndex = re.lastIndex;
                    }
                    const rest = piece.slice(lastIndex);
                    if (rest) frag.appendChild(document.createTextNode(rest));
                    return;
                }

                const hasPlaceholder = piece.indexOf("\u0001") !== -1;

                if (run.safe && looksLikeMathRun(piece) && !hasPlaceholder) {
                    changed = true;
                    appendMathSpan(frag, piece);
                    return;
                }

                if (!hasPlaceholder) {
                    frag.appendChild(document.createTextNode(piece));
                    return;
                }

                changed = true; // this run has a \text{} that must be swapped in as plain text
                const re = /\u0001(\d+)\u0002/g;
                let lastIndex = 0, m;
                while ((m = re.exec(piece)) !== null) {
                    const before = piece.slice(lastIndex, m.index);
                    if (before) {
                        if (run.safe && looksLikeMathRun(before)) {
                            appendMathSpan(frag, before);
                        } else {
                            frag.appendChild(document.createTextNode(before));
                        }
                    }
                    frag.appendChild(document.createTextNode(textSpans[Number(m[1])]));
                    lastIndex = re.lastIndex;
                }

                let rest = piece.slice(lastIndex);
                if (rest) {
                    const exp = consumeLeadingExponent(rest);
                    if (exp) {
                        const supEl = document.createElement("sup");
                        supEl.textContent = exp.sup;
                        frag.appendChild(supEl);
                        rest = exp.restAfter;
                    }
                    if (rest) {
                        if (run.safe && looksLikeMathRun(rest)) {
                            appendMathSpan(frag, rest);
                        } else {
                            frag.appendChild(document.createTextNode(rest));
                        }
                    }
                }
            });

            if (changed) {
                textNode.parentNode.replaceChild(frag, textNode);
            }
        });
    }

    // "चाल = दूरी/समय" — a plain Hindi word equation with a bare "/"
    // for division and NO LaTeX markup at all. This is different from
    // (and runs independently of) the naked-LaTeX handling above: there
    // no backslash/^_ ever appears, so the TreeWalker filter up there
    // never even looks at this text. Renders it as a proper stacked
    // fraction — each side must be a SINGLE Devanagari word (no spaces).
    // That's deliberately narrow: a run of multiple words would happily
    // keep matching straight into trailing prose like "समय होता है" and
    // swallow "होता है" into the denominator, so multi-word
    // numerator/denominator formulas ("वेग में परिवर्तन/समय अन्तराल")
    // are left alone rather than risk that.
    const PLAIN_WORD_FRACTION_RE = /([\u0900-\u097F]+)\s*=\s*([\u0900-\u097F]+)\s*\/\s*([\u0900-\u097F]+)/g;

    function renderPlainWordFractionsInBlock(el) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
                PLAIN_WORD_FRACTION_RE.lastIndex = 0;
                if (!PLAIN_WORD_FRACTION_RE.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
                if (node.parentElement && node.parentElement.closest(".latex-formula")) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const targets = [];
        let node;
        while ((node = walker.nextNode())) targets.push(node);

        targets.forEach((textNode) => {
            const text = textNode.nodeValue;
            PLAIN_WORD_FRACTION_RE.lastIndex = 0;
            const frag = document.createDocumentFragment();
            let lastIndex = 0, m, changed = false;
            while ((m = PLAIN_WORD_FRACTION_RE.exec(text)) !== null) {
                changed = true;
                const before = text.slice(lastIndex, m.index);
                if (before) frag.appendChild(document.createTextNode(before));
                const lhs = m[1].trim(), num = m[2].trim(), den = m[3].trim();
                appendMathSpan(frag, "\\text{" + lhs + "}=\\dfrac{\\text{" + num + "}}{\\text{" + den + "}}");
                lastIndex = PLAIN_WORD_FRACTION_RE.lastIndex;
            }
            const rest = text.slice(lastIndex);
            if (rest) frag.appendChild(document.createTextNode(rest));
            if (changed) textNode.parentNode.replaceChild(frag, textNode);
        });
    }

    // Never auto-render the block the user's caret is currently
    // inside — that's what stops "LaTeX turning into a formula
    // mid-typing" and losing focus.
    function activeBlockIn(page) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return null;
        const node = sel.getRangeAt(0).startContainer;
        if (!page.contains(node)) return null;
        let n = node.nodeType === 3 ? node.parentElement : node;
        while (n && n.parentElement !== page) n = n.parentElement;
        return n;
    }


    // After a paste the caret sits at the very end of what was pasted, so
    // the last pasted line is "the block being typed in" and would stay raw
    // LaTeX until the user tapped elsewhere. A paste is a finished action,
    // not typing — so for one render pass that block is rendered too, and
    // the caret is put back at its end.
    let renderActiveOnce = false;

    function renderMathInPage(page) {
        window.WPSEditor.attachMarkdownBlocksInPage(page);
        upgradeImagesInPage(page);
        if (!autoRenderEnabled || !window.katex) return;
        const active = document.activeElement === page ? activeBlockIn(page) : null;
        const skip = renderActiveOnce ? null : active;
        const blocks = page.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th");
        blocks.forEach((el) => {
            if (el === skip) return;
            if (el.querySelector(".fake-caret")) return; // don't destroy a pending tap position
            const hasFormula = !!el.querySelector(".latex-formula");

            if (!hasFormula) {
                const raw = el.textContent.trim();
                if (!raw) return;
                if (raw.indexOf("$") === -1 && isPureLatex(raw)) {
                    renderBlockMath(el, raw);
                    return;
                }
            } else {
                // formula already rendered (e.g. loaded from a saved
                // document) — make sure it's actually clickable
                el.querySelectorAll(".latex-formula").forEach(attachEditToggle);
            }

            // $...$ / $$...$$ — also when the block already holds other
            // rendered formulas (a formula tapped open for editing turns
            // back into "$...$" text and must re-render next to them).
            if (el.textContent.indexOf("$") !== -1) renderInlineMath(el);

            // Naked-latex (no $ delimiters) is always safe to re-check,
            // even when the block already has OTHER rendered formulas
            // sitting next to it (e.g. two formulas on one line) — its
            // tree-walker only ever touches text that isn't already
            // inside a .latex-formula, so this can't double-render or
            // loop. Without this, tapping one of several formulas on a
            // line to edit it, then tapping away, left it stuck as raw
            // text forever because the line looked "already rendered".
            const rawText = el.textContent;
            if (rawText && (rawText.indexOf("\\") !== -1 || /[\^_]/.test(rawText))) {
                renderNakedLatexInBlock(el);
            }
            renderPlainWordFractionsInBlock(el);
        });
        wrapOverflowingFormulas(page);
        if (renderActiveOnce && active) {
            const target = active.isConnected ? active : page.lastElementChild;
            if (target) {
                const r = document.createRange();
                r.selectNodeContents(target);
                r.collapse(false);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(r);
            }
        }
    }

    function armPasteRender() { renderActiveOnce = true; }
    function disarmPasteRender() { renderActiveOnce = false; }

    /* ==================================================
       6. IMAGE INSERT + SIZE PANEL
       Images sit in a <div class="img-wrap"> (its own block line).
       There is no drag handle any more: tapping an image opens a small
       panel to set width / height in mm, lock or change the aspect
       ratio, choose how the picture fills its box, align it, or delete
       it. The size lives on the <img> itself (style width/height in mm),
       so saving, printing and PDF export need nothing extra.
    ================================================== */
    let activePageForInsert = null;

    function rememberActivePage() {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const page = closestPage(sel.getRangeAt(0).startContainer);
            if (page) activePageForInsert = page;
        }
    }

    const imageWrapReady = new WeakSet();
    let selectedWrap = null;
    let imgPanelEl = null;

    // Keeps old saved documents working: strips the retired drag handle
    // and any leftover "selected" outline, and wires the tap listener.
    function upgradeImagesInPage(page) {
        page.querySelectorAll(".img-wrap").forEach((wrap) => {
            wrap.querySelectorAll(".img-resize-handle").forEach((h) => h.remove());
            wrap.contentEditable = "false";
            if (wrap !== selectedWrap) wrap.classList.remove("img-selected");
            if (!imageWrapReady.has(wrap)) {
                imageWrapReady.add(wrap);
                wrap.addEventListener("click", function (e) {
                    e.stopPropagation();
                    selectImage(wrap);
                });
            }
        });
    }

    // Converts between CSS px and mm the same way the layout does, so it
    // stays right at any zoom level.
    function pxPerMm(page) {
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;visibility:hidden;width:100mm;height:1px;";
        page.appendChild(probe);
        const v = probe.offsetWidth / 100;
        probe.remove();
        return v || 3.7795;
    }

    function columnWidthPx(page) {
        const cs = getComputedStyle(page);
        const count = parseInt(cs.columnCount, 10) || 1;
        const gap = parseFloat(cs.columnGap) || 0;
        const inner = page.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
        return (inner - gap * (count - 1)) / count;
    }

    const RATIO_CHOICES = [
        ["orig", "मूल अनुपात"],
        ["1", "1 : 1"],
        [String(4 / 3), "4 : 3"],
        [String(3 / 4), "3 : 4"],
        [String(16 / 9), "16 : 9"],
        [String(9 / 16), "9 : 16"],
        [String(1 / 1.4142), "A4 खड़ा"]
    ];

    function buildImagePanel() {
        const el = document.createElement("div");
        el.id = "img-panel";
        el.className = "no-print";
        el.hidden = true;
        el.innerHTML =
            '<div class="ip-row ip-head"><b>🖼️ चित्र का आकार</b><button type="button" data-act="close" class="ip-x">✕</button></div>' +
            '<div class="ip-row">' +
                '<label>चौड़ाई <input id="ip-w" type="number" min="5" step="1" inputmode="decimal"> मिमी</label>' +
                '<label>ऊँचाई <input id="ip-h" type="number" min="5" step="1" inputmode="decimal"> मिमी</label>' +
            '</div>' +
            '<div class="ip-row">' +
                '<label class="ip-check"><input id="ip-lock" type="checkbox" checked> अनुपात लॉक</label>' +
                '<select id="ip-ratio">' + RATIO_CHOICES.map((r) => '<option value="' + r[0] + '">' + r[1] + "</option>").join("") + "</select>" +
                '<select id="ip-fit"><option value="fill">खींचकर भरें</option><option value="cover">काटकर भरें</option><option value="contain">पूरा दिखाएँ</option></select>' +
            '</div>' +
            '<div class="ip-row ip-btns">' +
                '<button type="button" data-act="col">कॉलम भर</button>' +
                '<button type="button" data-act="half">आधा</button>' +
                '<button type="button" data-act="orig">मूल आकार</button>' +
                '<button type="button" data-act="al-l" title="बाएँ">⬅</button>' +
                '<button type="button" data-act="al-c" title="बीच में">⬌</button>' +
                '<button type="button" data-act="al-r" title="दाएँ">➡</button>' +
                '<button type="button" data-act="del" class="ip-del">🗑 हटाएँ</button>' +
            '</div>';
        document.body.appendChild(el);

        // keep taps inside the panel from moving the page caret or
        // being read as "tap elsewhere"
        ["mousedown", "touchstart", "click"].forEach((ev) =>
            el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true })
        );

        const wInput = el.querySelector("#ip-w");
        const hInput = el.querySelector("#ip-h");
        const lock = el.querySelector("#ip-lock");
        const ratioSel = el.querySelector("#ip-ratio");
        const fitSel = el.querySelector("#ip-fit");

        wInput.addEventListener("input", () => onDimInput("w"));
        hInput.addEventListener("input", () => onDimInput("h"));
        ratioSel.addEventListener("change", onRatioChange);
        fitSel.addEventListener("change", () => {
            const img = currentImg();
            if (!img) return;
            img.style.objectFit = fitSel.value;
            afterImageChange();
        });
        el.addEventListener("click", (e) => {
            const btn = e.target.closest("button[data-act]");
            if (btn) onPanelAction(btn.getAttribute("data-act"));
        });
        return el;
    }

    function currentImg() {
        return selectedWrap && selectedWrap.isConnected ? selectedWrap.querySelector("img") : null;
    }

    function readImageMm() {
        const img = currentImg();
        if (!img) return null;
        const page = closestPage(img);
        const k = pxPerMm(page);
        const cs = getComputedStyle(img);   // CSS px: fractional and unaffected by the zoom transform
        return { w: (parseFloat(cs.width) || img.offsetWidth) / k, h: (parseFloat(cs.height) || img.offsetHeight) / k, k: k, page: page, img: img };
    }

    function writeImageMm(wMm, hMm) {
        const info = readImageMm();
        if (!info) return;
        const maxW = columnWidthPx(info.page) / info.k;
        if (wMm > maxW) { hMm = hMm * (maxW / wMm); wMm = maxW; }   // never wider than the column
        wMm = Math.max(5, wMm);
        hMm = Math.max(5, hMm);
        info.img.style.width = wMm.toFixed(1) + "mm";
        info.img.style.height = hMm.toFixed(1) + "mm";
        syncPanelFields();
        afterImageChange();
    }

    function currentRatio() {
        const sel = imgPanelEl.querySelector("#ip-ratio").value;
        const img = currentImg();
        if (sel === "orig") return img && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
        return parseFloat(sel) || 1;
    }

    function syncPanelFields() {
        const info = readImageMm();
        if (!info || !imgPanelEl) return;
        imgPanelEl.querySelector("#ip-w").value = Math.round(info.w * 10) / 10;
        imgPanelEl.querySelector("#ip-h").value = Math.round(info.h * 10) / 10;
        imgPanelEl.querySelector("#ip-fit").value = info.img.style.objectFit || "fill";
    }

    function onDimInput(which) {
        const w = parseFloat(imgPanelEl.querySelector("#ip-w").value);
        const h = parseFloat(imgPanelEl.querySelector("#ip-h").value);
        const locked = imgPanelEl.querySelector("#ip-lock").checked;
        const info = readImageMm();
        if (!info) return;
        if (which === "w" && w > 0) {
            const r = locked ? (info.w / info.h) : 0;
            writeImageMm(w, locked ? w / r : (h > 0 ? h : info.h));
        } else if (which === "h" && h > 0) {
            const r = locked ? (info.w / info.h) : 0;
            writeImageMm(locked ? h * r : (w > 0 ? w : info.w), h);
        }
    }

    function onRatioChange() {
        const info = readImageMm();
        if (!info) return;
        const r = currentRatio();
        // a ratio different from the picture's own would squash it, so
        // crop-to-fill is the sensible default there
        const sel = imgPanelEl.querySelector("#ip-ratio").value;
        info.img.style.objectFit = sel === "orig" ? "fill" : "cover";
        writeImageMm(info.w, info.w / r);
    }

    function onPanelAction(act) {
        const info = readImageMm();
        if (act === "close") { closeImagePanel(); return; }
        if (!info) return;
        const maxW = columnWidthPx(info.page) / info.k;
        if (act === "col") writeImageMm(maxW, maxW / (info.w / info.h));
        else if (act === "half") writeImageMm(maxW / 2, (maxW / 2) / (info.w / info.h));
        else if (act === "orig") {
            const nw = info.img.naturalWidth / info.k, nh = info.img.naturalHeight / info.k;
            imgPanelEl.querySelector("#ip-ratio").value = "orig";
            info.img.style.objectFit = "fill";
            writeImageMm(nw, nh);
        } else if (act.indexOf("al-") === 0) {
            selectedWrap.setAttribute("data-align", act === "al-l" ? "left" : act === "al-r" ? "right" : "center");
            afterImageChange();
        } else if (act === "del") {
            const wrap = selectedWrap;
            closeImagePanel();
            if (wrap && wrap.isConnected) { wrap.remove(); window.WPSEditor.scheduleRepagination(); }
        }
    }

    function afterImageChange() {
        window.WPSEditor.scheduleRepagination();
    }

    function selectImage(wrap) {
        if (!imgPanelEl) imgPanelEl = buildImagePanel();
        if (selectedWrap && selectedWrap !== wrap) selectedWrap.classList.remove("img-selected");
        selectedWrap = wrap;
        wrap.classList.add("img-selected");
        imgPanelEl.hidden = false;
        // images from older documents may still carry a % width — convert
        // it to real mm the first time the panel opens
        const info = readImageMm();
        if (info && !/mm$/.test(info.img.style.width)) {
            info.img.style.width = (info.w).toFixed(1) + "mm";
            info.img.style.height = (info.h).toFixed(1) + "mm";
            info.img.style.objectFit = info.img.style.objectFit || "fill";
        }
        imgPanelEl.querySelector("#ip-ratio").value = "orig";
        syncPanelFields();
    }

    function closeImagePanel() {
        if (selectedWrap) selectedWrap.classList.remove("img-selected");
        selectedWrap = null;
        if (imgPanelEl) imgPanelEl.hidden = true;
    }

    // Called by the touch-gesture layer (zoom-keyboard.js) on a clean
    // tap: returns true when the tap landed on an image (so the caller
    // skips its own caret placement).
    function handleImageTap(target) {
        const wrap = target && target.closest ? target.closest(".img-wrap") : null;
        if (wrap) { selectImage(wrap); return true; }
        if (selectedWrap && !(target && target.closest && target.closest("#img-panel"))) closeImagePanel();
        return false;
    }

    document.addEventListener("click", function (e) {
        if (!selectedWrap) return;
        if (e.target.closest && (e.target.closest(".img-wrap") || e.target.closest("#img-panel"))) return;
        closeImagePanel();
    });

    // Large photos would bloat the saved document and the PDF request,
    // so they are scaled down (longest side 1600px) when inserted.
    function shrinkImage(dataUrl, done) {
        const im = new Image();
        im.onload = function () {
            const w = im.naturalWidth, h = im.naturalHeight;
            const scale = Math.min(1, 1600 / Math.max(w, h));
            if (scale === 1 && dataUrl.length < 350000) { done(dataUrl); return; }
            const c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(w * scale));
            c.height = Math.max(1, Math.round(h * scale));
            const ctx = c.getContext("2d");
            const isPng = /^data:image\/png/i.test(dataUrl);
            if (!isPng) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
            ctx.drawImage(im, 0, 0, c.width, c.height);
            let out = isPng ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.86);
            if (isPng && out.length > 900000) {
                ctx.globalCompositeOperation = "destination-over";
                ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
                out = c.toDataURL("image/jpeg", 0.86);
            }
            done(out.length < dataUrl.length ? out : dataUrl);
        };
        im.onerror = function () { done(dataUrl); };
        im.src = dataUrl;
    }

    function insertImageAtCaret(page, dataUrl) {
        const wrap = document.createElement("div");
        wrap.className = "img-wrap";
        wrap.contentEditable = "false"; // wrapper itself isn't text-editable, just the page around it

        const img = document.createElement("img");
        img.src = dataUrl;
        img.style.width = "60%";

        wrap.appendChild(img);

        const sel = window.getSelection();
        let inserted = false;
        if (sel && sel.rangeCount > 0 && page.contains(sel.getRangeAt(0).startContainer)) {
            const range = sel.getRangeAt(0);
            let block = range.startContainer;
            block = block.nodeType === 3 ? block.parentElement : block;
            while (block && block.parentElement !== page) block = block.parentElement;
            if (block) {
                block.after(wrap);
                inserted = true;
            }
        }
        if (!inserted) page.appendChild(wrap);

        // start a fresh empty paragraph right after the image so
        // typing continues on a new line below it
        const nextP = document.createElement("p");
        nextP.innerHTML = "<br>";
        wrap.after(nextP);

        const range = document.createRange();
        range.setStart(nextP, 0);
        range.collapse(true);
        const sel2 = window.getSelection();
        sel2.removeAllRanges();
        sel2.addRange(range);
        page.focus({ preventScroll: true });

        upgradeImagesInPage(page);
        const open = function () { selectImage(wrap); window.WPSEditor.scheduleRepagination(); };
        if (img.complete && img.naturalWidth) open(); else img.addEventListener("load", open, { once: true });
    }

    function getActivePage() {
        return activePageForInsert || document.querySelector(".page");
    }

    window.insertImage = function () {
        const page = getActivePage();
        if (!page) return;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.addEventListener("change", () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => shrinkImage(reader.result, (small) => insertImageAtCaret(page, small));
            reader.readAsDataURL(file);
        });
        input.click();
    };

    /* ==================================================
       CORE INIT + PUBLIC EXPORTS
       Everything pagination.js (or any other file) needs from
       core is exposed here — nothing else is reachable from
       outside this file's closure.
    ================================================== */
    function initCore() {
        activePageForInsert = document.querySelector(".page");
        initRenderStatusToggle();
        allPages().forEach(renderMathInPage);
    }


    Object.assign(window.WPSEditor, {
        closestPage: closestPage,
        allPages: allPages,
        renderMathInPage: renderMathInPage,
        handlePaste: handlePaste,
        rememberActivePage: rememberActivePage,
        handleImageTap: handleImageTap,
        closeImagePanel: closeImagePanel,
        wrapOverflowingFormulas: wrapOverflowingFormulas,
        armPasteRender: armPasteRender,
        disarmPasteRender: disarmPasteRender,
        normalizeMathDelimiters: normalizeMathDelimiters,
        getActivePage: getActivePage,
        cleanPasteToParagraphs: cleanPasteToParagraphs,
        sanitizePastedHtml: sanitizePastedHtml,
        initCore: initCore
    });
})();
