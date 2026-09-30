/* ======================================================
   SHARED MATH HELPERS — math-shared.js
   Loaded in the browser (before editor-core.js) AND required by the
   Node backend, so a formula is prepared, split and rendered in exactly
   the same way on screen and in the exported PDF / image.
   ====================================================== */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.WPSMath = factory();
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // AI chat exports write "\mum" for micrometre; not a real command.
    var MACROS = { "\\mum": "\\mu m" };

    // Wraps every bare (not already inside \text{...}) run of Devanagari
    // with \text{...}. KaTeX's math fonts have no Devanagari glyphs.
    function wrapBareDevanagari(str) {
        var kept = [];
        var out = str.replace(/\\text\{[^}]*\}/g, function (m) {
            kept.push(m);
            return "\u0003" + (kept.length - 1) + "\u0004";
        });
        out = out.replace(/[\u0900-\u097F]+(?:[ \u0900-\u097F]*[\u0900-\u097F])?/g, function (m) {
            return "\\text{" + m + "}";
        });
        return out.replace(/\u0003(\d+)\u0004/g, function (m, idx) { return kept[Number(idx)]; });
    }

    // What actually gets handed to KaTeX for a given stored source.
    function prepareLatex(source) {
        // \frac renders small in KaTeX's text style; \dfrac gives the larger
        // "display style" used in textbooks.
        var s = source.replace(/\\frac(?![a-zA-Z])/g, "\\dfrac");
        if (/[\u0900-\u097F]/.test(s)) s = wrapBareDevanagari(s);
        return s;
    }

    // KaTeX never breaks a formula by itself. A long one (e.g. a set of
    // many tuples) is cut at its top-level commas so the pieces can wrap.
    function splitLatexAtCommas(latex) {
        if (/\\left|\\right|\\begin|\\end|\\\\/.test(latex)) return null; // pairs that must stay in one piece
        var chunks = [];
        var start = 0, brace = 0, paren = 0;
        for (var i = 0; i < latex.length; i++) {
            var c = latex[i];
            if (c === "\\") { i++; continue; }              // skip escaped char (\{ \} \, ...)
            if (c === "{") brace++;
            else if (c === "}") brace = Math.max(0, brace - 1);
            else if (c === "(" || c === "[") paren++;
            else if (c === ")" || c === "]") paren = Math.max(0, paren - 1);
            else if (c === "," && brace === 0 && paren === 0) {
                chunks.push(latex.slice(start, i + 1));
                start = i + 1;
            }
        }
        chunks.push(latex.slice(start));
        var cleaned = chunks.map(function (c) { return c.trim(); }).filter(Boolean);
        return cleaned.length > 1 ? cleaned : null;
    }

    return {
        MACROS: MACROS,
        wrapBareDevanagari: wrapBareDevanagari,
        prepareLatex: prepareLatex,
        splitLatexAtCommas: splitLatexAtCommas
    };
});
