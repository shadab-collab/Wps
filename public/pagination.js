/* ======================================================
   PAGINATION ENGINE — pagination.js
   Page/column creation, overflow detection, repagination,
   Save-as-PDF. This is the file most likely to be rewritten when
   the column-splitting approach changes (browser CSS columns ->
   JS-managed column boxes) — everything editor-core.js needs is
   kept behind window.WPSEditor so this file can be replaced on
   its own.
   ====================================================== */

(function () {
    "use strict";

    window.WPSEditor = window.WPSEditor || {};

    /* ------------------------------------------------
       STATE
    ------------------------------------------------ */
    let isRepaginating = false;
    const debounceTimers = new WeakMap();
    const RENDER_DELAY = 600;      // ms pause before auto-rendering math
    const REPAGINATE_DELAY = 200;  // ms pause before repagination

    /* ------------------------------------------------
       UTIL
    ------------------------------------------------ */
    function debounce(map, key, fn, delay) {
        if (map.has(key)) clearTimeout(map.get(key));
        map.set(key, setTimeout(fn, delay));
    }

    function closestPage(node) {
        let n = node && node.nodeType === 3 ? node.parentElement : node;
        while (n && (!n.classList || !n.classList.contains("page"))) n = n.parentElement;
        return n;
    }

    function allPages() {
        return Array.from(document.querySelectorAll(".page"));
    }

    /* ==================================================
       7. AUTO PAGINATION
       column-count:3 + fixed page height + overflow:hidden means
       overflow shows up as extra "virtual" columns off to the
       right — i.e. scrollWidth > clientWidth, not scrollHeight.
    ================================================== */
    function isOverflowing(page) {
        return page.scrollWidth > page.clientWidth + 1;
    }

    function createPageWrapper(index) {
        const wrapper = document.createElement("div");
        wrapper.className = "page-wrapper";
        wrapper.id = "page-wrapper-" + index;

        const info = document.createElement("div");
        info.className = "page-header-info no-print";
        info.textContent = "PAGE " + index;

        const page = document.createElement("div");
        page.id = "page-" + index;
        page.className = "page";
        page.contentEditable = "true";
        page.spellcheck = false;
        page.setAttribute("autocomplete", "off");
        page.setAttribute("autocorrect", "off");
        page.setAttribute("autocapitalize", "off");

        const pageNumber = document.createElement("div");
        pageNumber.className = "page-number";
        pageNumber.textContent = String(index);

        wrapper.appendChild(info);
        wrapper.appendChild(page);
        wrapper.appendChild(pageNumber);
        attachPageListeners(page);
        return wrapper;
    }

    function getOrCreateNextPage(currentPage) {
        const wrapper = currentPage.closest(".page-wrapper");
        let nextWrapper = wrapper.nextElementSibling;
        if (!nextWrapper) {
            const index = document.querySelectorAll(".page-wrapper").length + 1;
            nextWrapper = createPageWrapper(index);
            wrapper.after(nextWrapper);
        }
        return nextWrapper.querySelector(".page");
    }

    // A list that's the ONLY thing overflowing a page shouldn't have to
    // move in its entirety — moving its trailing items onto the next
    // page (instead of the whole element) keeps this page filled and
    // avoids the classic "half the page is blank" look for anything
    // longer than one page's worth of items.
    function isSplittableList(el) {
        return !!el && (el.tagName === "UL" || el.tagName === "OL");
    }

    // Only ever merge into a list on the next page that WE created as
    // the continuation of this same split — never into some unrelated
    // list that just happens to start the next page, which would wrongly
    // splice two separate lists (and their numbering) into one.
    function isSplitContinuation(el) {
        return !!el && el.dataset && el.dataset.splitContinuation === "true";
    }

    function moveOverflowForward(page) {
        let guard = 0;
        while (isOverflowing(page) && page.children.length > 0 && guard < 500) {
            const lastChild = page.lastElementChild;
            if (!lastChild) break;
            const nextPage = getOrCreateNextPage(page);

            if (isSplittableList(lastChild) && lastChild.children.length > 1) {
                let nextList = nextPage.firstElementChild;
                if (!nextList || nextList.tagName !== lastChild.tagName || !isSplitContinuation(nextList)) {
                    nextList = document.createElement(lastChild.tagName);
                    nextList.dataset.splitContinuation = "true";
                    nextPage.insertBefore(nextList, nextPage.firstChild);
                }
                // Move items from the end of this list to the front of
                // the next page's list, one at a time, stopping the
                // moment this page fits — far better than shoving the
                // WHOLE list over and leaving this page half-blank.
                while (isOverflowing(page) && lastChild.children.length > 1) {
                    nextList.insertBefore(lastChild.lastElementChild, nextList.firstChild);
                }
                if (lastChild.tagName === "OL" || nextList.tagName === "OL") {
                    const firstStart = parseInt(lastChild.getAttribute("start") || "1", 10);
                    nextList.setAttribute("start", String(firstStart + lastChild.children.length));
                }
                if (!lastChild.children.length) lastChild.remove();
                guard += 1;
                continue;
            }

            // A list reduced to its last single item (or one that never
            // needed splitting) still shouldn't fork into a second,
            // separately-numbered list if the next page already starts
            // with a matching one — merge it in instead.
            if (isSplittableList(lastChild)) {
                const target = nextPage.firstElementChild;
                if (target && target.tagName === lastChild.tagName && isSplitContinuation(target)) {
                    const firstStart = parseInt(lastChild.getAttribute("start") || "1", 10);
                    while (lastChild.lastElementChild) target.insertBefore(lastChild.lastElementChild, target.firstChild);
                    if (lastChild.tagName === "OL" || target.tagName === "OL") target.setAttribute("start", String(firstStart));
                    lastChild.remove();
                    guard += 1;
                    continue;
                }
            }

            if (page.children.length <= 1) break; // nothing left that can move without fully emptying the page
            nextPage.insertBefore(lastChild, nextPage.firstChild);
            guard += 1;
        }
    }

    function pullBackFromNext(page) {
        const wrapper = page.closest(".page-wrapper");
        const nextWrapper = wrapper.nextElementSibling;
        if (!nextWrapper) return;
        const nextPage = nextWrapper.querySelector(".page");
        let guard = 0;

        while (nextPage && nextPage.firstElementChild && guard < 500) {
            const candidate = nextPage.firstElementChild;
            const target = page.lastElementChild;

            // A split-continuation list at the top of the next page can
            // give back its items one at a time to a matching list at
            // the end of this page, instead of only ever moving in
            // whole-element chunks — otherwise a list that was split
            // stays needlessly split even once earlier edits free up
            // room for more of it here.
            if (isSplitContinuation(candidate) && target && target.tagName === candidate.tagName) {
                let movedAny = false;
                while (candidate.firstElementChild) {
                    target.appendChild(candidate.firstElementChild);
                    movedAny = true;
                    if (isOverflowing(page)) {
                        candidate.insertBefore(target.lastElementChild, candidate.firstChild); // doesn't fit — put back
                        movedAny = false;
                        break;
                    }
                }
                if (target.tagName === "OL" && candidate.children.length) {
                    const targetStart = parseInt(target.getAttribute("start") || "1", 10);
                    candidate.setAttribute("start", String(targetStart + target.children.length));
                }
                if (!candidate.children.length) candidate.remove();
                if (movedAny || !candidate.isConnected) { guard += 1; continue; }
                break;
            }

            page.appendChild(candidate);
            if (isOverflowing(page)) {
                nextPage.insertBefore(candidate, nextPage.firstChild); // doesn't fit — put back
                break;
            }
            guard += 1;
        }
    }

    function removeEmptyTrailingPages() {
        const wrappers = Array.from(document.querySelectorAll(".page-wrapper"));
        for (let i = wrappers.length - 1; i > 0; i--) {
            const page = wrappers[i].querySelector(".page");
            if (page && page.children.length === 0) {
                wrappers[i].remove();
            } else {
                break;
            }
        }
        renumberPages();
    }

    function renumberPages() {
        const wrappers = Array.from(document.querySelectorAll(".page-wrapper"));
        wrappers.forEach((wrapper, idx) => {
            const n = idx + 1;
            wrapper.id = "page-wrapper-" + n;
            const info = wrapper.querySelector(".page-header-info");
            if (info) info.textContent = "PAGE " + n;
            const page = wrapper.querySelector(".page");
            if (page) page.id = "page-" + n;
            let pageNumber = wrapper.querySelector(".page-number");
            if (!pageNumber) {
                pageNumber = document.createElement("div");
                pageNumber.className = "page-number";
                wrapper.appendChild(pageNumber);
            }
            pageNumber.textContent = String(n);
        });
    }

    // Large pastes can create many pages; doing all of their overflow
    // checks in one synchronous loop forces dozens of expensive layout
    // recalculations back-to-back and can block the browser long enough
    // to look frozen. Processing a few pages per animation frame keeps
    // the UI responsive and lets pages appear progressively instead.
    const PAGES_PER_FRAME = 3;
    const MAX_TOTAL_ITERATIONS = 4000; // hard safety cap — never spin forever
    let repaginateQueue = [];
    let repaginateFrame = null;
    let pendingRepaginateCallbacks = [];

    function repaginateAll(onDone) {
        if (onDone) pendingRepaginateCallbacks.push(onDone);
        if (isRepaginating) return;
        isRepaginating = true;

        const sel = window.getSelection();
        const hadRange = sel && sel.rangeCount > 0;
        const savedRange = hadRange ? sel.getRangeAt(0).cloneRange() : null;

        repaginateQueue = allPages();
        let idx = 0;
        let totalIterations = 0;
        let finished = false;

        // Safety net: if repagination ever gets stuck for any reason
        // (an edge case with a large document, an unexpected loop,
        // etc.), this guarantees we still reach finish() within a
        // bounded time — so print/PDF/save can never silently hang
        // forever, which is exactly what large (100+ page) documents
        // need to stay reliable.
        const watchdog = setTimeout(() => {
            if (!finished) {
                if (repaginateFrame) {
                    cancelAnimationFrame(repaginateFrame);
                    repaginateFrame = null;
                }
                finish();
            }
        }, 8000);

        function finish() {
            if (finished) return;
            finished = true;
            clearTimeout(watchdog);
            removeEmptyTrailingPages();
            if (savedRange) {
                try {
                    if (document.contains(savedRange.startContainer)) {
                        const sel2 = window.getSelection();
                        sel2.removeAllRanges();
                        sel2.addRange(savedRange);
                        const page = closestPage(savedRange.startContainer);
                        if (page) page.focus({ preventScroll: true });
                    }
                } catch (e) { /* not fatal */ }
            }
            isRepaginating = false;
            const callbacks = pendingRepaginateCallbacks;
            pendingRepaginateCallbacks = [];
            callbacks.forEach((cb) => cb());
        }

        // If anything inside a single page's overflow/pull-back logic
        // throws, we still MUST reach finish() and reset isRepaginating —
        // otherwise every future paste/edit would silently stop
        // repaginating at all (looking exactly like a permanent freeze).
        function processBatch() {
            try {
                let doneInBatch = 0;
                while (idx < repaginateQueue.length && doneInBatch < PAGES_PER_FRAME) {
                    if (totalIterations++ > MAX_TOTAL_ITERATIONS) {
                        repaginateFrame = null;
                        finish();
                        return;
                    }
                    const page = repaginateQueue[idx];
                    if (page.isConnected) {
                        if (isOverflowing(page)) {
                            moveOverflowForward(page);
                        } else {
                            pullBackFromNext(page);
                        }
                    }
                    repaginateQueue = allPages(); // more pages may have been created mid-loop
                    idx++;
                    doneInBatch++;
                }
            } catch (e) {
                repaginateFrame = null;
                finish();
                return;
            }
            if (idx < repaginateQueue.length) {
                repaginateFrame = requestAnimationFrame(processBatch);
            } else {
                repaginateFrame = null;
                finish();
            }
        }

        processBatch();
    }

    function scheduleRepagination() {
        debounce(debounceTimers, "repaginate", () => repaginateAll(), REPAGINATE_DELAY);
    }

    function scheduleForPage(page) {
        debounce(debounceTimers, page, () => {
            window.WPSEditor.renderMathInPage(page);
            window.WPSEditor.applyAutoBoldToAllQuestionLines(page);
            repaginateAll();
        }, RENDER_DELAY);
    }

    /* ==================================================
       8. SAVE AS PDF (direct download via backend)
    ================================================== */
    function getCurrentCssVars() {
        const vars = [
            "--font-size", "--line-height", "--top-margin", "--bottom-margin",
            "--inside-margin", "--outside-margin", "--gutter-margin", "--column-gap"
        ];
        const style = getComputedStyle(document.documentElement);
        return vars.map((v) => v + ":" + style.getPropertyValue(v).trim() + ";").join("");
    }

    window.saveAsPDF = function () {
        repaginateAll(() => {
            const container = document.getElementById("pages-container");
            const html = container.innerHTML;
            const cssVars = getCurrentCssVars();

            fetch("/api/export-pdf", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ html, cssVars })
            })
                .then((res) => {
                    if (!res.ok) throw new Error("export failed");
                    return res.blob();
                })
                .then((blob) => {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "document.pdf";
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    URL.revokeObjectURL(url);
                })
                .catch(() => {
                    // backend export not available/failed — fall back to
                    // the browser's own print dialog so PDF export never
                    // just silently does nothing
                    window.print();
                });
        });
    };

    // Always-available fallback if the direct download ever misbehaves
    // on a particular device/browser.
    window.saveAsPDFViaPrint = function () {
        repaginateAll(() => window.print());
    };

    /* ==================================================
       9. EVENT WIRING
    ================================================== */
    function attachPageListeners(page) {
        page.addEventListener("input", () => {
            window.WPSEditor.checkAutoBoldQuestionLine(page);
            scheduleForPage(page);
        });
        page.addEventListener("paste", (e) => window.WPSEditor.handlePaste(e));
        page.addEventListener("focus", () => window.WPSEditor.rememberActivePage());
        page.addEventListener("click", () => window.WPSEditor.rememberActivePage());
        page.addEventListener("keyup", () => window.WPSEditor.rememberActivePage());
    }

    function init() {
        document.execCommand("defaultParagraphSeparator", false, "p");
        window.WPSEditor.initCore();
        allPages().forEach((page) => {
            attachPageListeners(page);
        });
        renumberPages();
        repaginateAll();
    }

    Object.assign(window.WPSEditor, {
        scheduleRepagination: scheduleRepagination,
        scheduleForPage: scheduleForPage,
        repaginateAll: repaginateAll,
        attachPageListeners: attachPageListeners,
        createPageWrapper: createPageWrapper,
        renumberPages: renumberPages,
        getCurrentCssVars: getCurrentCssVars
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
