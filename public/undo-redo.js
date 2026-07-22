/* ======================================================
   UNDO / REDO — undo-redo.js
   Native browser undo (Ctrl+Z / execCommand) can't be trusted here
   — pagination moves whole paragraphs between pages and math
   rendering replaces text nodes with KaTeX spans, both of which
   scramble the browser's own undo history. So instead, this file
   watches #pages-container for any settled change (debounced) and
   keeps a capped stack of full-content snapshots to restore from.
   ====================================================== */

(function () {
    "use strict";

    const UNDO_LIMIT = 50;
    const SNAPSHOT_DELAY = 800; // ms of no further changes before snapshotting

    let undoStack = [];
    let redoStack = [];
    let snapshotTimer = null;
    let suppressCapture = false; // true while WE are restoring, so that doesn't itself get captured

    function pagesContainer() {
        return document.getElementById("pages-container");
    }

    function pushSnapshot() {
        const container = pagesContainer();
        if (!container) return;
        const html = container.innerHTML;
        if (undoStack.length && undoStack[undoStack.length - 1] === html) return; // nothing actually changed
        undoStack.push(html);
        if (undoStack.length > UNDO_LIMIT) undoStack.shift();
        redoStack = []; // a fresh change invalidates any old redo history
    }

    function scheduleSnapshot() {
        if (suppressCapture) return;
        clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(pushSnapshot, SNAPSHOT_DELAY);
    }

    function restoreSnapshot(html) {
        const container = pagesContainer();
        if (!container) return;
        suppressCapture = true;
        container.innerHTML = html;
        document.querySelectorAll(".page").forEach((page) => {
            window.WPSEditor.attachPageListeners(page);
            window.WPSEditor.renderMathInPage(page);
        });
        window.WPSEditor.renumberPages();
        window.WPSEditor.repaginateAll();
        setTimeout(() => { suppressCapture = false; }, 100);
    }

    window.editorUndo = function () {
        if (undoStack.length < 2) return; // nothing earlier to go back to
        const current = undoStack.pop();
        redoStack.push(current);
        restoreSnapshot(undoStack[undoStack.length - 1]);
    };

    window.editorRedo = function () {
        if (!redoStack.length) return;
        const next = redoStack.pop();
        undoStack.push(next);
        restoreSnapshot(next);
    };

    function init() {
        const container = pagesContainer();
        if (!container) return;
        pushSnapshot(); // capture the starting state
        const observer = new MutationObserver(scheduleSnapshot);
        observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
