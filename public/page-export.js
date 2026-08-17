/* ======================================================
   PAGE IMAGE EXPORT — page-export.js
   Lets the user pick one or more specific pages (not the whole
   document) and download each as a high-resolution PNG image —
   useful for sharing a single worksheet page on WhatsApp etc.
   without generating a full PDF.

   Rendered on the backend via the same headless browser used for
   PDF export (not the client-side html2canvas library), because
   html2canvas cannot correctly render the 3-column page layout —
   it was drawing all the text stacked on top of itself.
   ====================================================== */

(function () {
    "use strict";

    let selectMode = false;
    const selectedWrappers = new Set();

    function pageWrappers() {
        return Array.from(document.querySelectorAll(".page-wrapper"));
    }

    function addCheckbox(wrapper) {
        if (wrapper.querySelector(".page-select-box")) return;
        const box = document.createElement("div");
        box.className = "page-select-box no-print";
        box.textContent = "☐";
        box.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            toggleSelected(wrapper, box);
        });
        wrapper.appendChild(box);
    }

    function removeCheckboxes() {
        document.querySelectorAll(".page-select-box").forEach((b) => b.remove());
        document.querySelectorAll(".page-wrapper.page-selected").forEach((w) => w.classList.remove("page-selected"));
        selectedWrappers.clear();
    }

    function toggleSelected(wrapper, box) {
        if (selectedWrappers.has(wrapper)) {
            selectedWrappers.delete(wrapper);
            wrapper.classList.remove("page-selected");
            box.textContent = "☐";
        } else {
            selectedWrappers.add(wrapper);
            wrapper.classList.add("page-selected");
            box.textContent = "☑";
        }
    }

    window.togglePageSelectMode = function () {
        selectMode = !selectMode;
        const btn = document.getElementById("select-pages-btn");
        if (selectMode) {
            pageWrappers().forEach(addCheckbox);
            if (btn) btn.classList.add("btn-success");
        } else {
            removeCheckboxes();
            if (btn) btn.classList.remove("btn-success");
        }
    };

    async function exportWrapperAsImage(wrapper, index) {
        const page = wrapper.querySelector(".page");
        if (!page) return;
        const cssVars = window.WPSEditor.getCurrentCssVars ? window.WPSEditor.getCurrentCssVars() : "";

        const res = await fetch("/api/export-image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pageHtml: page.innerHTML, cssVars })
        });
        if (!res.ok) {
            let detail = "";
            try {
                const errBody = await res.json();
                detail = errBody.detail || errBody.error || "";
            } catch (e) { /* response wasn't JSON */ }
            throw new Error("Page " + (index + 1) + ": " + (detail || "export failed"));
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "page-" + (index + 1) + ".png";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    window.exportSelectedPagesAsImage = async function () {
        if (!selectedWrappers.size) {
            alert("पहले 'Select Pages' चालू करके कम-से-कम एक page चुनें।");
            return;
        }
        const wrappers = pageWrappers();
        const errors = [];
        for (const wrapper of selectedWrappers) {
            const index = wrappers.indexOf(wrapper);
            try {
                await exportWrapperAsImage(wrapper, index);
            } catch (e) {
                errors.push(e.message || String(e));
            }
        }
        if (errors.length) {
            alert("समस्या हुई:\n" + errors.join("\n"));
        }
    };

    /* ==================================================
       REVERSE SELECTED PAGES (Urdu flip-book ordering)
       Swaps CONTENT (not position) among the selected pages, back to
       front — page 51's content becomes what page 70 had, 52 becomes
       69, and so on. Deliberately swaps only innerHTML + the page's own
       class (e.g. urdu-page) and leaves every .page-wrapper exactly
       where it already was in the DOM: margin (odd/even gutter side)
       and the printed page-number label are both driven purely by
       *position* in style.css / renumberPages(), so they keep working
       correctly for whatever content now sits at that position — no
       separate margin fix-up needed.
    ================================================== */
    window.reverseSelectedPages = function () {
        if (!selectMode || !selectedWrappers.size) {
            alert("पहले 'Select Pages' चालू करके वे पेज चुनें जिनका क्रम पलटना है (कम से कम 2)।");
            return;
        }
        const ordered = pageWrappers().filter((w) => selectedWrappers.has(w));
        if (ordered.length < 2) {
            alert("कम से कम 2 पेज चुनें जिनका क्रम पलटना है।");
            return;
        }
        if (!confirm(ordered.length + " चुने हुए पेजों का क्रम पलटा जाएगा (पहला ↔ आख़िरी, इत्यादि)। आगे बढ़ें?")) return;

        const pages = ordered.map((w) => w.querySelector(".page")).filter(Boolean);
        const snapshot = pages.map((p) => ({ html: p.innerHTML, className: p.className }));
        const reversedSnapshot = snapshot.slice().reverse();

        pages.forEach((p, i) => {
            p.innerHTML = reversedSnapshot[i].html;
            p.className = reversedSnapshot[i].className;
        });

        // Re-wire what just got swapped in — formulas, markdown-block
        // double-tap-to-edit, etc. (Page-level listeners like
        // click/paste/focus stay attached fine on their own; only the
        // *content* inside changed, not the .page node itself.)
        pages.forEach((p) => window.WPSEditor.renderMathInPage(p));
        window.WPSEditor.renumberPages();
        window.WPSEditor.repaginateAll();

        togglePageSelectMode(); // done — exit select mode, same as a completed export
    };
})();
