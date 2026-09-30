const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer-core");
const { renderFormulas, documentShell, exclusive, LAUNCH_ARGS } = require("./render-html");

// The exported PDF reuses the editor's own style.css, so margins, columns,
// fonts and page numbers match the on-screen A4 layout exactly.
router.post("/", async (req, res) => {
    const { html, cssVars } = req.body || {};
    if (!html) {
        return res.status(400).json({ error: "कोई content नहीं मिला" });
    }

    try {
        const pdfBuffer = await exclusive(async () => {
            const fullHtml = documentShell(
                '<div class="editor-container" id="pages-container">' + renderFormulas(html) + "</div>",
                cssVars
            );

            let browser;
            try {
                browser = await puppeteer.launch({
                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                    headless: "new",
                    args: LAUNCH_ARGS,
                    timeout: 60000
                });
                const page = await browser.newPage();
                page.setDefaultTimeout(180000);
                page.setDefaultNavigationTimeout(180000);
                // everything is inlined — never wait for (or fetch) anything external
                await page.setRequestInterception(true);
                page.on("request", (r) => (/^(data:|about:)/.test(r.url()) ? r.continue() : r.abort()));

                await page.setContent(fullHtml, { waitUntil: "load", timeout: 180000 });
                await page.evaluate("document.fonts.ready");
                await page.emulateMediaType("print");
                return await page.pdf({ format: "A4", printBackground: true, timeout: 180000 });
            } finally {
                if (browser) await browser.close().catch(() => {});
            }
        });

        res.set({
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="document.pdf"'
        });
        res.send(pdfBuffer);
    } catch (err) {
        console.error("PDF export error:", err);
        res.status(500).json({ error: "PDF बनाने में समस्या हुई", detail: String((err && err.message) || err) });
    }
});

module.exports = router;
