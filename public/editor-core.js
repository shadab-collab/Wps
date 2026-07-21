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

    function inlineMarkdown(text) {
        let out = escapeHtml(text);
        out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
        out = out.replace(/\*(.+?)\*/g, "<i>$1</i>");
        out = out.replace(/(^|[^\w])_(.+?)_([^\w]|$)/g, "$1<i>$2</i>$3");
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

    function markdownLineToHtml(line) {
        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            const level = Math.min(heading[1].length, 6);
            return "<h" + level + ">" + inlineMarkdown(heading[2]) + "</h" + level + ">";
        }
        const bullet = line.match(/^[-*]\s+(.*)$/);
        if (bullet) {
            return "<li>" + inlineMarkdown(bullet[1]) + "</li>";
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
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        const htmlParts = [];
        let listType = null; // "ul" | "ol" | null
        let inBlockquote = false;
        let i = 0;

        function closeList() {
            if (listType) { htmlParts.push(listType === "ul" ? "</ul>" : "</ol>"); listType = null; }
        }
        function closeBlockquote() {
            if (inBlockquote) { htmlParts.push("</blockquote>"); inBlockquote = false; }
        }

        while (i < lines.length) {
            const trimmed = lines[i].trim();
            if (trimmed === "") { i++; continue; } // drop blank lines entirely

            if (isTableRow(trimmed)) {
                closeList(); closeBlockquote();
                const rows = [];
                while (i < lines.length && isTableRow(lines[i].trim())) {
                    const rowLine = lines[i].trim();
                    if (!isTableSeparatorRow(rowLine)) rows.push(splitTableCells(rowLine));
                    i++;
                }
                if (rows.length) htmlParts.push(tableRowsToHtml(rows));
                continue;
            }

            // "> quoted text" — consecutive quote lines merge into one
            // <blockquote> with one <p> per line, same as GitHub/most
            // Markdown renderers.
            const quoteMatch = trimmed.match(/^>\s?(.*)$/);
            if (quoteMatch) {
                closeList();
                if (!inBlockquote) { htmlParts.push("<blockquote>"); inBlockquote = true; }
                htmlParts.push("<p>" + inlineMarkdown(quoteMatch[1]) + "</p>");
                i++;
                continue;
            }
            closeBlockquote();

            const orderedMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
            if (orderedMatch) {
                if (listType !== "ol") { closeList(); htmlParts.push("<ol>"); listType = "ol"; }
                htmlParts.push("<li>" + inlineMarkdown(orderedMatch[1]) + "</li>");
                i++;
                continue;
            }

            const isBullet = /^[-*]\s+/.test(trimmed);
            if (isBullet) {
                if (listType !== "ul") { closeList(); htmlParts.push("<ul>"); listType = "ul"; }
                const bulletMatch = trimmed.match(/^[-*]\s+(.*)$/);
                htmlParts.push("<li>" + inlineMarkdown(bulletMatch[1]) + "</li>");
                i++;
                continue;
            }

            closeList();
            htmlParts.push(markdownLineToHtml(trimmed));
            i++;
        }
        closeList();
        closeBlockquote();
        return htmlParts.join("");
    }

    function handlePaste(e) {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData("text/plain");
        if (!text) return;
        const html = cleanPasteToParagraphs(text) || "<p></p>";
        document.execCommand("insertHTML", false, html);
        const page = closestPage(e.target);
        if (page) window.WPSEditor.scheduleForPage(page);
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
            window.katex.render(source, target, {
                throwOnError: false,
                displayMode: displayMode,
                macros: { "\\ce": "\\ce" }
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
    function attachEditToggle(span) {
        span.addEventListener("click", function (e) {
            e.stopPropagation();
            const raw = span.getAttribute("data-latex") || "";
            const textNode = document.createTextNode(raw);
            span.replaceWith(textNode);

            const range = document.createRange();
            range.selectNodeContents(textNode);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);

            const page = closestPage(textNode);
            if (page) {
                if (window.WPSKeyboard && !window.WPSKeyboard.isKeyboardMode()) {
                    // enters keyboard mode first (so the real keyboard
                    // opens and later taps use real selection), then
                    // re-apply our range since focus() alone can shift
                    // the browser's own selection to elsewhere in the page
                    window.WPSKeyboard.enableKeyboardModeAt(page);
                    const sel3 = window.getSelection();
                    sel3.removeAllRanges();
                    sel3.addRange(range);
                } else {
                    page.focus({ preventScroll: true });
                }
            }

            let block = textNode.parentElement;
            while (block && block.parentElement !== page) block = block.parentElement;
            if (block) watchForBlockExit(page, block);
        });
    }

    function renderBlockMath(el, raw) {
        el.textContent = "";
        const span = document.createElement("span");
        span.className = "latex-formula";
        span.setAttribute("data-latex", raw);
        safeKatexRender(raw, span, true);
        attachEditToggle(span);
        el.appendChild(span);
    }

    // Recognises every common delimiter style AI chat tools export:
    // $$...$$ and \[...\] render as display (block-style) math, $...$
    // and \(...\) render inline. Order matters — $$ is checked before
    // single $ so "$$x$$" isn't mis-split into two empty $ matches.
    const INLINE_MATH_RE = /\$\$([^$]+)\$\$|\\\[([^\]]+)\\\]|\$([^$]+)\$|\\\(([^)]+)\\\)/g;

    function renderInlineMath(el) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
            acceptNode: function (node) {
                if (!node.nodeValue || !/\$|\\\(|\\\[/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
                if (node.parentElement && node.parentElement.closest(".latex-formula")) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });

        const targets = [];
        let node;
        while ((node = walker.nextNode())) targets.push(node);

        targets.forEach((textNode) => {
            const text = textNode.nodeValue;
            let match, lastIndex = 0, found = false;
            const frag = document.createDocumentFragment();
            INLINE_MATH_RE.lastIndex = 0;

            while ((match = INLINE_MATH_RE.exec(text)) !== null) {
                found = true;
                if (match.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                const isDisplay = match[1] !== undefined || match[2] !== undefined; // $$..$$ or \[..\]
                const latex = match[1] || match[2] || match[3] || match[4];
                const span = document.createElement("span");
                span.className = "latex-formula";
                span.setAttribute("data-latex", latex);
                safeKatexRender(latex, span, isDisplay);
                attachEditToggle(span);
                frag.appendChild(span);
                lastIndex = INLINE_MATH_RE.lastIndex;
            }

            if (found) {
                if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
                textNode.parentNode.replaceChild(frag, textNode);
            }
        });
    }

    function appendMathSpan(frag, latex) {
        const span = document.createElement("span");
        span.className = "latex-formula";
        span.setAttribute("data-latex", latex);
        safeKatexRender(latex, span, false);
        attachEditToggle(span);
        frag.appendChild(span);
    }

    // Characters LaTeX commands are normally built from. A run made
    // only of these, sitting inside otherwise-Hindi text, is treated
    // as a math island IF it also contains a backslash command or a
    // ^/_ (so plain numbers/English words aren't wrongly rendered).
    const LATEX_SAFE_CHAR_RE = /[\\{}A-Za-z0-9+\-=_^().,\/\[\]\s*<>|:;'"!%~\u0001\u0002]/;
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


    function renderMathInPage(page) {
        window.WPSEditor.attachMarkdownBlocksInPage(page);
        if (!autoRenderEnabled || !window.katex) return;
        const skip = document.activeElement === page ? activeBlockIn(page) : null;
        const blocks = page.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th");
        blocks.forEach((el) => {
            if (el === skip) return;
            if (el.querySelector(".fake-caret")) return; // don't destroy a pending tap position
            const hasFormula = !!el.querySelector(".latex-formula");

            if (!hasFormula) {
                const raw = el.textContent.trim();
                if (!raw) return;
                // Whole block wrapped in $$...$$ or \[...\] — a full
                // display equation sitting alone on its own line/cell.
                const blockWrap = raw.match(/^\$\$([\s\S]+)\$\$$/) || raw.match(/^\\\[([\s\S]+)\\\]$/);
                if (blockWrap) {
                    renderBlockMath(el, blockWrap[1].trim());
                    return;
                }
                if (isPureLatex(raw)) {
                    renderBlockMath(el, raw);
                    return;
                } else if (/\$|\\\(|\\\[/.test(raw)) {
                    renderInlineMath(el);
                    return;
                }
            }

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
        });
    }

    /* ==================================================
       6. IMAGE INSERT + RESIZE
       Images are wrapped in a <div class="img-wrap"> so a resize
       handle can sit on the corner without becoming part of the
       image itself. The wrapper is block-level (its own <p>-like
       line), which is what makes the next line start below the
       image instead of text wrapping beside it.
    ================================================== */
    let activePageForInsert = null;

    function rememberActivePage() {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
            const page = closestPage(sel.getRangeAt(0).startContainer);
            if (page) activePageForInsert = page;
        }
    }

    function attachResizeHandle(wrap, img) {
        const handle = document.createElement("span");
        handle.className = "img-resize-handle no-print";
        wrap.appendChild(handle);

        let startX = 0;
        let startWidth = 0;

        function onMove(clientX) {
            const delta = clientX - startX;
            const newWidth = Math.max(40, startWidth + delta);
            const maxWidth = wrap.parentElement ? wrap.parentElement.clientWidth : newWidth;
            img.style.width = Math.min(newWidth, maxWidth) + "px";
        }

        function mouseMove(e) { onMove(e.clientX); }
        function mouseUp() {
            document.removeEventListener("mousemove", mouseMove);
            document.removeEventListener("mouseup", mouseUp);
            window.WPSEditor.scheduleRepagination();
        }
        function touchMove(e) { onMove(e.touches[0].clientX); e.preventDefault(); }
        function touchEnd() {
            document.removeEventListener("touchmove", touchMove);
            document.removeEventListener("touchend", touchEnd);
            window.WPSEditor.scheduleRepagination();
        }

        handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            startX = e.clientX;
            startWidth = img.getBoundingClientRect().width;
            document.addEventListener("mousemove", mouseMove);
            document.addEventListener("mouseup", mouseUp);
        });

        handle.addEventListener("touchstart", (e) => {
            e.stopPropagation();
            startX = e.touches[0].clientX;
            startWidth = img.getBoundingClientRect().width;
            document.addEventListener("touchmove", touchMove, { passive: false });
            document.addEventListener("touchend", touchEnd);
        });
    }

    function insertImageAtCaret(page, dataUrl) {
        const wrap = document.createElement("div");
        wrap.className = "img-wrap";
        wrap.contentEditable = "false"; // wrapper itself isn't text-editable, just the page around it

        const img = document.createElement("img");
        img.src = dataUrl;
        img.style.width = "60%";

        wrap.appendChild(img);
        attachResizeHandle(wrap, img);

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

        window.WPSEditor.scheduleRepagination();
    }

    window.insertImage = function () {
        const page = activePageForInsert || document.querySelector(".page");
        if (!page) return;

        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.addEventListener("change", () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => insertImageAtCaret(page, reader.result);
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
        cleanPasteToParagraphs: cleanPasteToParagraphs,
        initCore: initCore
    });
})();