/* ======================================================
   EDITOR EXTRAS — editor-extras.js
   The newest, most actively-evolving features: Markdown-block
   raw-edit toggle (tables/headings/lists) and marker-driven line
   tools (■ serial numbers, ◆ bold-line toggle). Kept separate from
   editor-core.js so ongoing changes/bug-fixes here never risk the
   more settled core (formatting, paste, math, images).
   ====================================================== */

(function () {
    "use strict";

    window.WPSEditor = window.WPSEditor || {};

    /* ==================================================
       REMOVE EMPTY LINES
       Manual cleanup button: after pasting (from Gemini or anywhere
       else), this walks every page and deletes any paragraph/list
       item that has no real visible content — including lines that
       only contain invisible characters (zero-width space etc.) or
       a stray <br>. Anything with real text, an image, a table, or a
       math formula is left untouched. Runs on demand so the user
       decides when to clean up, instead of us guessing at paste time.
    ================================================== */
    function blockHasRealContent(el) {
        // Keep any line that carries non-text content — an image,
        // table, or rendered/raw math formula — even if its text
        // looks empty.
        if (el.querySelector("img, table, .latex-formula")) return true;
        const text = el.textContent.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, "").trim();
        return text !== "";
    }

    // Force-closes any raw-edit box currently stuck open (see the
    // blur/selectionchange note below — this is the direct cleanup for
    // ones that got stuck before that fix, or by some other fluke)
    // instead of waiting for the user to somehow refocus them. Uses
    // the same safe renderer as normal exit, so this can no longer
    // wipe a box's content the way a plain rebuild-and-replace could.
    function closeAllOpenMdRawEdits() {
        document.querySelectorAll(".md-raw-edit").forEach(renderRawEditBoxSafely);
    }

    // Drops stray leading/trailing <br> inside a paragraph/list item —
    // these add blank vertical space without any text before/after
    // them — and collapses any run of consecutive <br> in the middle
    // down to one. This is the "extra gap inside one paragraph" case;
    // blockHasRealContent above only catches a paragraph that's blank
    // as a WHOLE, not extra spacing living inside an otherwise-real one.
    function normalizeParagraphBreaks(page) {
        page.querySelectorAll("p, li").forEach((el) => {
            while (el.firstChild && el.firstChild.nodeName === "BR") el.removeChild(el.firstChild);
            while (el.lastChild && el.lastChild.nodeName === "BR") el.removeChild(el.lastChild);
            Array.from(el.querySelectorAll("br")).forEach((br) => {
                let next = br.nextSibling;
                while (next && next.nodeName === "BR") {
                    const toRemove = next;
                    next = next.nextSibling;
                    toRemove.remove();
                }
            });
        });
    }

    window.removeEmptyLines = function () {
        closeAllOpenMdRawEdits();
        const pages = window.WPSEditor.allPages();
        let removedCount = 0;
        pages.forEach((page) => {
            page.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6").forEach((el) => {
                if (!blockHasRealContent(el)) {
                    el.remove();
                    removedCount++;
                }
            });
            // A list left with no <li> after the above has nothing to
            // show — drop the now-empty wrapper too.
            page.querySelectorAll("ul, ol").forEach((el) => {
                if (!el.querySelector("li")) el.remove();
            });
            normalizeParagraphBreaks(page);
            // Also re-normalize every table/list/heading on the page —
            // this is the same cleanup that used to require double-
            // tapping each block and tapping away, now forced for all
            // of them (even ones already marked "clean" earlier, so
            // content pasted before this fix existed gets caught too).
            if (window.WPSEditor.normalizeAllMdBlocksInPage) window.WPSEditor.normalizeAllMdBlocksInPage(page);
        });
        window.WPSEditor.renumberPages();
        window.WPSEditor.repaginateAll();
        if (removedCount === 0) alert("कोई खाली पंक्ति नहीं मिली।");
    };

    /* ==================================================
       4B. MARKDOWN BLOCK RAW-EDIT TOGGLE
       Tables, headings, and bullet lists behave like LaTeX
       formulas: double-tap reveals the underlying Markdown source
       (freely editable — add/remove table rows, list items,
       change heading level, etc.), tapping away re-renders it.
       Single tap still does normal in-place text editing (e.g.
       fixing a typo in one table cell), since that's handled by
       ordinary contenteditable and isn't touched by this.
    ================================================== */
    // Like el.textContent, but for any rendered .latex-formula inside,
    // uses its stored data-latex source instead of the live rendered
    // text — KaTeX embeds a hidden copy of the raw LaTeX (for screen
    // readers) inside every formula it renders, and plain .textContent
    // would pull that in too, duplicating the formula when round-
    // tripped back to raw Markdown.
    function cleanTextForMarkdown(el) {
        let result = "";
        el.childNodes.forEach((node) => {
            if (node.nodeType === 3) {
                result += node.nodeValue;
            } else if (node.nodeType === 1) {
                if (node.classList && node.classList.contains("latex-formula")) {
                    result += node.getAttribute("data-latex") || "";
                } else if (node.tagName === "BR") {
                    // A <br> is a real line break in the original —
                    // gluing the words on either side together with no
                    // separator at all makes the text unreadable and,
                    // for something like "प्रश्न...<br>उत्तर:...", can
                    // even fuse two sentences into one illegible run.
                    // A single space keeps them as separate words.
                    if (result && !/\s$/.test(result)) result += " ";
                } else {
                    const before = result;
                    result += cleanTextForMarkdown(node);
                    // Same reasoning for block-level children (nested
                    // <p>, <li>, headings, table cells): keep them from
                    // running into each other with zero separation.
                    const BLOCK_TAGS = /^(P|DIV|LI|H[1-6]|TR|TD|TH)$/;
                    if (BLOCK_TAGS.test(node.tagName) && result.length > before.length && !/\s$/.test(result)) {
                        result += " ";
                    }
                }
            }
        });
        return result;
    }

    // Same invisible-character definition as the paste-time cleaner in
    // editor-core.js — various zero-width/thin-space/BOM characters
    // that AI apps use for spacing instead of a truly empty line, so a
    // plain .trim() alone won't catch them as blank.
    const INVISIBLE_CHARS = /[\u200B\u200C\u200D\uFEFF\u00A0\u2060\u180E\u2000-\u200A\u3000]/g;
    function isBlankMd(str) {
        return str.replace(INVISIBLE_CHARS, "").trim() === "";
    }

    function domTableToMarkdown(table) {
        const rows = Array.from(table.querySelectorAll("tr")).filter(
            (tr) => !Array.from(tr.children).every((c) => isBlankMd(cleanTextForMarkdown(c)))
        );
        if (!rows.length) return "";
        const lines = rows.map((tr) => {
            const cells = Array.from(tr.children).map((c) => cleanTextForMarkdown(c).trim());
            return "| " + cells.join(" | ") + " |";
        });
        const colCount = rows[0].children.length;
        const sep = "|" + Array(colCount).fill(" --- ").join("|") + "|";
        lines.splice(1, 0, sep);
        return lines.join("\n");
    }

    function domListToMarkdown(list) {
        const items = Array.from(list.children).filter(
            (c) => c.tagName === "LI" && !isBlankMd(cleanTextForMarkdown(c))
        );
        // Keep numbered lists numbered through the round trip — an
        // <ol> becomes "1. item", "2. item"... (cleanPasteToParagraphs
        // rebuilds an <ol> from that); a <ul> keeps the plain "- item"
        // it always used, rebuilding a bullet <ul>.
        const ordered = list.tagName === "OL";
        return items
            .map((li, idx) => (ordered ? idx + 1 + ". " : "- ") + cleanTextForMarkdown(li).trim())
            .join("\n");
    }

    function domHeadingToMarkdown(h) {
        const level = Number(h.tagName.charAt(1));
        return "#".repeat(level) + " " + cleanTextForMarkdown(h).trim();
    }

    function markdownSourceFor(el) {
        if (el.tagName === "TABLE") return domTableToMarkdown(el);
        if (el.tagName === "UL" || el.tagName === "OL") return domListToMarkdown(el);
        if (/^H[1-6]$/.test(el.tagName)) return domHeadingToMarkdown(el);
        return cleanTextForMarkdown(el);
    }

    // Reuses the same paste-time Markdown parser to turn edited raw
    // text back into a rendered element, so raw-edit and paste always
    // agree on syntax. IMPORTANT: parsing a big block of raw text can
    // legitimately produce MULTIPLE top-level elements (e.g. a stray
    // non-bullet line in the middle of a list closes that <ul> and
    // opens a new one after it) — returning only the first one, as
    // this used to do, silently threw everything after it away. A
    // DocumentFragment carries all of them; replaceWith() unpacks a
    // fragment's children automatically, so every caller keeps working
    // unchanged.
    function markdownSourceToElement(raw) {
        const html = window.WPSEditor.cleanPasteToParagraphs(raw) || "<p></p>";
        const temp = document.createElement("div");
        temp.innerHTML = html;
        if (!temp.firstChild) return document.createTextNode(raw);
        const frag = document.createDocumentFragment();
        while (temp.firstChild) frag.appendChild(temp.firstChild);
        return frag;
    }

    // attachMarkdownEditToggle only makes sense on an actual
    // table/heading/list element — call it on each such top-level node
    // BEFORE the fragment is inserted (inserting a DocumentFragment
    // empties it, so attaching to the fragment itself would attach to
    // nothing).
    function attachToggleToTopNodes(nodeOrFragment) {
        const nodes = nodeOrFragment.nodeType === 11 ? Array.from(nodeOrFragment.childNodes) : [nodeOrFragment];
        nodes.forEach((node) => {
            if (node.nodeType === 1 && /^(TABLE|UL|OL|H[1-6])$/.test(node.tagName)) {
                attachMarkdownEditToggle(node);
            }
        });
    }

    // Guaranteed-safe fallback for a raw-edit box: one <p> per non-
    // blank line, no bullet/table/heading reconstruction attempted.
    // Used only when the normal rebuild looks like it lost content —
    // this can never lose a line, so it's the last line of defense
    // against ending up with an empty page.
    function safeParagraphFallback(raw) {
        const frag = document.createDocumentFragment();
        raw.split("\n").forEach((line) => {
            if (isBlankMd(line)) return;
            const p = document.createElement("p");
            p.textContent = line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
            frag.appendChild(p);
        });
        return frag.childNodes.length ? frag : null;
    }

    function isSafeRawRebuild(raw, rendered) {
        const origText = raw.replace(INVISIBLE_CHARS, "").trim();
        const newText = (rendered.textContent || "").replace(INVISIBLE_CHARS, "").trim();
        if (origText.length > 20 && newText.length < origText.length * 0.7) return false;

        const nonBlankLines = raw.split("\n").filter((l) => !isBlankMd(l)).length;
        const newRows = rendered.querySelectorAll
            ? rendered.querySelectorAll("li, tr, p, h1, h2, h3, h4, h5, h6").length
            : 0;
        if (nonBlankLines > 1 && newRows < nonBlankLines * 0.6) return false;

        return true;
    }

    // The one place a raw-edit box turns back into rendered content —
    // used on normal exit (tap/scroll away) AND by the manual cleanup
    // button for boxes found stuck open. Tries the real Markdown
    // rebuild first; if that looks like it lost content, drops to the
    // line-preserving fallback instead of ever leaving the page blank.
    function renderRawEditBoxSafely(editableEl) {
        const raw = editableEl.textContent;
        let rendered = markdownSourceToElement(raw);
        if (!rendered || rendered.nodeType === 3 || !isSafeRawRebuild(raw, rendered)) {
            rendered = safeParagraphFallback(raw);
        }
        if (!rendered) {
            editableEl.remove(); // raw was entirely blank — nothing to keep
            return;
        }
        attachToggleToTopNodes(rendered);
        editableEl.replaceWith(rendered);
    }

    function watchForMdBlockExit(editableEl) {
        let exited = false;
        function exit() {
            if (exited) return;
            exited = true;
            editableEl.removeEventListener("blur", exit);
            document.removeEventListener("selectionchange", check);
            if (!editableEl.isConnected) return;
            renderRawEditBoxSafely(editableEl);
            if (window.WPSEditor.scheduleRepagination) window.WPSEditor.scheduleRepagination();
        }
        function check() {
            const sel = window.getSelection();
            const stillInside = sel.rangeCount > 0 && editableEl.isConnected && editableEl.contains(sel.getRangeAt(0).startContainer);
            if (!stillInside) exit();
        }
        // selectionchange alone isn't reliable for a block big enough to
        // span past what's on screen — scrolling away and tapping a
        // toolbar button, or tapping blank page margin, can leave this
        // box "stuck" open (still showing raw "- dashes" text in its
        // dashed border) because no new text selection ever gets made
        // elsewhere. A plain contenteditable blur is a much more
        // reliable "the user left this box" signal, so it's the
        // primary trigger; selectionchange stays as a fallback for the
        // normal case of tapping straight into another line of text.
        editableEl.addEventListener("blur", exit);
        document.addEventListener("selectionchange", check);
    }

    const mdToggleAttached = new WeakSet();

    function attachMarkdownEditToggle(el) {
        if (!el || mdToggleAttached.has(el)) return;
        mdToggleAttached.add(el);
        if (el.dataset) el.dataset.mdEditable = "1"; // lets the touch-gesture system identify these elements
        el.addEventListener("dblclick", function (e) {
            e.preventDefault();
            e.stopPropagation();
            const page = window.WPSEditor.closestPage(el);
            if (!page) return;
            const raw = markdownSourceFor(el);

            const editable = document.createElement("div");
            editable.className = "md-raw-edit";
            editable.contentEditable = "true";
            editable.textContent = raw;
            el.replaceWith(editable);

            const range = document.createRange();
            range.selectNodeContents(editable);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            page.focus({ preventScroll: true });

            watchForMdBlockExit(editable);
        });
    }

    function attachMarkdownBlocksInPage(page) {
        page.querySelectorAll("table, h1, h2, h3, h4, h5, h6, ul, ol").forEach((el) => {
            if (mdToggleAttached.has(el)) return; // already normalized earlier — leave alone
            normalizeMdBlock(el);
        });
    }

    // True while the caret is inside this element — used to skip
    // normalizing a block the user is actively typing in, so we never
    // yank the DOM out from under an in-progress edit.
    function elementContainsSelection(el) {
        const sel = window.getSelection();
        return !!(sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer));
    }

    // Safety net: the Markdown round-trip must never make a block
    // WORSE. Real content (a list item that itself spans several
    // lines, an oddly-nested table row, etc.) can come out of
    // cleanTextForMarkdown squeezed together in ways we didn't
    // anticipate — that's a cosmetic problem we can live with, but it
    // must never turn into actual data loss. Refuse the rebuilt
    // version — and keep the original exactly as it was — if it has
    // noticeably less text or fewer rows/items than what was there
    // before.
    function isSafeReplacement(original, rebuilt) {
        const origText = original.textContent.replace(INVISIBLE_CHARS, "").trim();
        const newText = rebuilt.textContent.replace(INVISIBLE_CHARS, "").trim();
        if (origText.length > 20 && newText.length < origText.length * 0.7) return false;

        const origRows = original.querySelectorAll("li, tr").length;
        const newRows = rebuilt.querySelectorAll("li, tr").length;
        if (origRows > 1 && newRows < origRows) return false;

        return true;
    }

    // Runs the exact same "read the block as Markdown, re-parse it"
    // round trip that happens today when you double-tap a block and
    // then tap away — but automatically, with no box ever shown. This
    // is what actually removes the stray blank/invisible bullet lines
    // and odd spacing that paste alone leaves behind (see
    // domListToMarkdown / domTableToMarkdown above, which already skip
    // blank rows — this is what puts that cleaned version back on the
    // page). Returns the element now on the page (new or original).
    function normalizeMdBlock(el) {
        if (!el.isConnected || elementContainsSelection(el)) {
            attachMarkdownEditToggle(el); // still editable; just don't rebuild it right now
            return el;
        }
        const raw = markdownSourceFor(el);
        const rendered = markdownSourceToElement(raw);
        // rendered is a DocumentFragment (nodeType 11) on the normal
        // path, or a bare text node (nodeType 3) only if parsing
        // produced nothing at all.
        if (rendered && rendered.nodeType !== 3 && isSafeReplacement(el, rendered)) {
            attachToggleToTopNodes(rendered);
            el.replaceWith(rendered);
            return rendered;
        }
        attachMarkdownEditToggle(el);
        return el;
    }

    // Forces re-normalization even for blocks already marked "clean"
    // — used by the manual cleanup button so it also fixes spacing on
    // content that was pasted before this normalizing existed.
    function normalizeAllMdBlocksInPage(page) {
        Array.from(page.querySelectorAll("table, h1, h2, h3, h4, h5, h6, ul, ol")).forEach(normalizeMdBlock);
    }

    /* ==================================================
       MARKER-DRIVEN LINE TOOLS
       ■ at the start of a line: "क्रमांक" button turns runs of
       consecutive ■-marked lines into 1,2,3... — each gap in
       marking restarts the count at 1 for the next run.
       ◆ at the start of a line: "Bold Line" button independently
       toggles bold for every ◆-marked line in the whole document.
    ================================================== */
    const SERIAL_MARKER = "■";
    const BOLD_MARKER = "◆";

    function allBlocksInDocOrder() {
        return Array.from(document.querySelectorAll(".page p, .page li"));
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    function findFirstTextNodeStartingWith(el, marker) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.trimStart().indexOf(marker) === 0) return node;
        }
        return null;
    }

    window.applySerialNumbers = function () {
        const blocks = allBlocksInDocOrder();
        let counter = 0;
        let prevWasMarked = false;
        blocks.forEach((el) => {
            const isMarked = el.textContent.trimStart().indexOf(SERIAL_MARKER) === 0;
            if (isMarked) {
                counter = prevWasMarked ? counter + 1 : 1;
                const textNode = findFirstTextNodeStartingWith(el, SERIAL_MARKER);
                if (textNode) {
                    textNode.nodeValue = textNode.nodeValue.replace(
                        new RegExp("^(\\s*)" + escapeRegExp(SERIAL_MARKER) + "\\s*"),
                        "$1" + counter + ". "
                    );
                }
            }
            prevWasMarked = isMarked;
        });
        window.WPSEditor.scheduleRepagination();
    };

    window.toggleBoldLines = function () {
        const blocks = allBlocksInDocOrder();
        blocks.forEach((el) => {
            if (el.textContent.trimStart().indexOf(BOLD_MARKER) === 0) {
                el.style.fontWeight = el.style.fontWeight === "bold" ? "" : "bold";
            }
        });
        window.WPSEditor.scheduleRepagination();
    };

    /* ==================================================
       CLIPBOARD PASTE BUTTON
       Some devices make the native long-press "Paste" menu
       unreliable, so this gives an explicit button that reads the
       clipboard and inserts it through the same Markdown/table
       parsing pipeline a normal paste event already uses.
    ================================================== */
    // Reads the OS clipboard directly. Prefers the rich "text/html"
    // entry (real <b>/<h2>/<ul> from apps like Gemini/Keep) so bold
    // and headings survive; falls back to plain text + Markdown
    // parsing only when no HTML flavor is on the clipboard, and
    // finally to the old readText()-only path on very old browsers.
    async function readClipboardHtmlAndText() {
        if (!navigator.clipboard || !navigator.clipboard.read) return null;
        const items = await navigator.clipboard.read();
        for (const item of items) {
            if (item.types.includes("text/html")) {
                const blob = await item.getType("text/html");
                const html = await blob.text();
                if (html && html.trim()) return { html: html };
            }
        }
        for (const item of items) {
            if (item.types.includes("text/plain")) {
                const blob = await item.getType("text/plain");
                const text = await blob.text();
                if (text) return { text: text };
            }
        }
        return null;
    }

    window.pasteFromClipboard = async function () {
        let html = null;

        try {
            const result = await readClipboardHtmlAndText();
            if (result && result.html) {
                html = window.WPSEditor.sanitizePastedHtml(result.html);
            }
            if (!html && result && result.text) {
                html = window.WPSEditor.cleanPasteToParagraphs(result.text);
            }
        } catch (e) {
            // navigator.clipboard.read() missing/denied — try the
            // plain-text-only API as a last resort below.
        }

        if (!html) {
            if (!navigator.clipboard || !navigator.clipboard.readText) {
                alert("यह browser क्लिपबोर्ड बटन को सपोर्ट नहीं करता — कृपया सीधे paste करें (hold करके)।");
                return;
            }
            try {
                const text = await navigator.clipboard.readText();
                if (!text) return;
                html = window.WPSEditor.cleanPasteToParagraphs(text);
            } catch (e) {
                alert("क्लिपबोर्ड पढ़ने की अनुमति नहीं मिली। ब्राउज़र की settings में clipboard access दें।");
                return;
            }
        }

        html = html || "<p></p>";
        document.execCommand("insertHTML", false, html);
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            const page = window.WPSEditor.closestPage(sel.getRangeAt(0).startContainer);
            if (page) window.WPSEditor.scheduleForPage(page);
        }
    };

    /* ==================================================
       AUTO-BOLD "प्रश्न" LINES
       Any paragraph/list-item starting with "प्रश्न" bolds itself
       automatically — live while typing that line, and also across
       a whole pasted block. Pressing Enter starts a brand-new
       paragraph element with no bold of its own, so the next line
       is normal until it too starts with "प्रश्न".
    ================================================== */
    const QUESTION_WORD = "प्रश्न";

    function applyAutoBoldToBlock(block) {
        if (!block || !block.style) return;
        const text = block.textContent.trimStart();
        const shouldBeBold = text.indexOf(QUESTION_WORD) === 0;

        if (shouldBeBold) {
            if (block.dataset.autoBoldQ !== "1") {
                block.style.fontWeight = "bold";
                block.dataset.autoBoldQ = "1";
            }
        } else if (block.dataset.autoBoldQ === "1") {
            block.style.fontWeight = "";
            delete block.dataset.autoBoldQ;
        }
    }

    // Live check of just the line the caret is currently in — cheap,
    // called on every keystroke so bolding appears immediately as
    // you type "प्रश्न" at the start of a line.
    window.checkAutoBoldQuestionLine = function (page) {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const node = sel.getRangeAt(0).startContainer;
        if (!page.contains(node)) return;
        let block = node.nodeType === 3 ? node.parentElement : node;
        while (block && block.parentElement !== page) block = block.parentElement;
        applyAutoBoldToBlock(block);
    };

    // Full-page sweep — catches pasted multi-paragraph content, where
    // several "प्रश्न..." lines can land at once, not just the one
    // the caret ends up in.
    window.applyAutoBoldToAllQuestionLines = function (page) {
        page.querySelectorAll("p, li").forEach(applyAutoBoldToBlock);
    };

    Object.assign(window.WPSEditor, {
        attachMarkdownBlocksInPage: attachMarkdownBlocksInPage,
        normalizeAllMdBlocksInPage: normalizeAllMdBlocksInPage,
        checkAutoBoldQuestionLine: window.checkAutoBoldQuestionLine,
        applyAutoBoldToAllQuestionLines: window.applyAutoBoldToAllQuestionLines
    });
})();
