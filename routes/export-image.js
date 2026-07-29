const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const styleCssPath = path.join(__dirname, "..", "public", "style.css");

router.post("/", async (req, res) => {
    const { pageHtml, cssVars } = req.body;
    if (!pageHtml) {
        return res.status(400).json({ error: "कोई content नहीं मिला" });
    }

    let styleCss = "";
    try {
        styleCss = fs.readFileSync(styleCssPath, "utf8");
    } catch (e) {
        // style.css missing from public/ — image will still generate, just unstyled
    }

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
<style>${styleCss}</style>
<style>
    body, .page { font-family: 'Noto Sans', 'Noto Sans Devanagari', sans-serif !important; }
    body { background: #fff; margin: 0; padding: 0; }
</style>
<style>:root{${cssVars || ""}}</style>
</head>
<body>
<div class="page-wrapper">
    <div class="page" id="export-page">${pageHtml}</div>
</div>
</body>
</html>`;

    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
            defaultViewport: { width: 850, height: 1200, deviceScaleFactor: 1.5 } // lighter than before — still sharp, less resource-heavy
        });
        const page = await browser.newPage();
        await page.setContent(fullHtml, { waitUntil: "networkidle0", timeout: 30000 });
        await page.evaluateHandle("document.fonts.ready");

        const el = await page.$("#export-page");
        if (!el) {
            throw new Error("export-page element not found after setContent");
        }
        const buffer = await el.screenshot({ type: "png", captureBeyondViewport: true });

        res.set({
            "Content-Type": "image/png",
            "Content-Disposition": 'attachment; filename="page.png"'
        });
        res.send(buffer);
    } catch (err) {
        console.error("Image export error:", err);
        res.status(500).json({ error: "Image बनाने में समस्या हुई", detail: String(err && err.message || err) });
    } finally {
        if (browser) await browser.close();
    }
});

module.exports = router;
