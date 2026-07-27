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
        if (!res.ok) throw new Error("export failed for page " + (index + 1));

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
        let failed = 0;
        for (const wrapper of selectedWrappers) {
            const index = wrappers.indexOf(wrapper);
            try {
                await exportWrapperAsImage(wrapper, index);
            } catch (e) {
                failed++;
            }
        }
        if (failed) {
            alert(failed + " page(s) को image में बदलने में समस्या हुई। कृपया फिर कोशिश करें।");
        }
    };
})();
