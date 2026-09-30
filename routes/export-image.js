const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer-core");
const { renderFormulas, documentShell, exclusive, LAUNCH_ARGS } = require("./render-html");

router.post("/", async (req, res) => {
    const { pageHtml, cssVars } = req.body || {};
    if (!pageHtml) {
        return res.status(400).json({ error: "कोई content नहीं मिला" });
    }

    try {
        const buffer = await exclusive(async () => {
            const fullHtml = documentShell(
                '<div class="page-wrapper">\n    <div class="page" id="export-page">' + renderFormulas(pageHtml) + "</div>\n</div>",
                cssVars
            );

            let browser;
            try {
                browser = await puppeteer.launch({
                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                    headless: "new",
                    args: LAUNCH_ARGS,
                    timeout: 60000,
                    defaultViewport: { width: 850, height: 1200, deviceScaleFactor: 1.5 } // lighter than before — still sharp, less resource-heavy
                });
                const page = await browser.newPage();
                page.setDefaultTimeout(90000);
                await page.setRequestInterception(true);
                page.on("request", (r) => (/^(data:|about:)/.test(r.url()) ? r.continue() : r.abort()));

                await page.setContent(fullHtml, { waitUntil: "load", timeout: 90000 });
                await page.evaluate("document.fonts.ready");

                const el = await page.$("#export-page");
                if (!el) throw new Error("export-page element not found after setContent");
                return await el.screenshot({ type: "png", captureBeyondViewport: true });
            } finally {
                if (browser) await browser.close().catch(() => {});
            }
        });

        res.set({
            "Content-Type": "image/png",
            "Content-Disposition": 'attachment; filename="page.png"'
        });
        res.send(buffer);
    } catch (err) {
        console.error("Image export error:", err);
        res.status(500).json({ error: "Image बनाने में समस्या हुई", detail: String((err && err.message) || err) });
    }
});

module.exports = router;
