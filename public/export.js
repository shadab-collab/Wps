const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");

// Reuses the editor's own style.css (must exist in backend/public/) so
// the exported PDF matches the on-screen A4 layout exactly — margins,
// columns, fonts, page numbers, everything.
const styleCssPath = path.join(__dirname, "..", "public", "style.css");

router.post("/", async (req, res) => {
    const { html, cssVars } = req.body;
    if (!html) {
        return res.status(400).json({ error: "कोई content नहीं मिला" });
    }

    let styleCss = "";
    try {
        styleCss = fs.readFileSync(styleCssPath, "utf8");
    } catch (e) {
        // style.css missing from public/ — PDF will still generate, just unstyled
    }

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
<style>${styleCss}</style>
<style>:root{${cssVars || ""}}</style>
</head>
<body>
<div class="editor-container" id="pages-container">${html}</div>
</body>
</html>`;

    let browser;
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless
        });
        const page = await browser.newPage();
        await page.setContent(fullHtml, { waitUntil: "networkidle0" });
        await page.emulateMediaType("print");
        const pdfBuffer = await page.pdf({ format: "A4", printBackground: true });

        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="document.pdf"'
        });
        res.send(pdfBuffer);
    } catch (err) {
        console.error("PDF export error:", err);
        res.status(500).json({ error: "PDF बनाने में समस्या हुई" });
    } finally {
        if (browser) await browser.close();
    }
});

module.exports = router;
