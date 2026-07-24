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

    function moveOverflowForward(page) {
        let guard = 0;
        while (isOverflowing(page) && page.children.length > 1 && guard < 500) {
            const lastChild = page.lastElementChild;
            const nextPage = getOrCreateNextPage(page);
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

        function finish() {
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
        page.addEventListener("input", () => scheduleForPage(page));
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
        renumberPages: renumberPages
    });

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
