const express = require("express");
const router = express.Router();
const Document = require("../models/Document");

// List documents (title + updatedAt only — NOT full content, to keep
// the list fast even with many/large saved documents).
// By default only the normal (non-archived) ones — matches both the
// homepage's "सेव्ड दस्तावेज़" list and the toolbar's document dropdown,
// so archived documents stay out of daily use without being deleted.
// ?archived=true instead returns only the archived ones, for the
// homepage's separate "आर्काइव" list. Documents saved before this field
// existed have no `archived` value at all — {$ne: true} treats that
// the same as false, so old documents keep showing up normally.
router.get("/", async (req, res) => {
    try {
        const wantArchived = req.query.archived === "true";
        const filter = wantArchived ? { archived: true } : { archived: { $ne: true } };
        const docs = await Document.find(filter, "title updatedAt archived").sort({ updatedAt: -1 });
        res.json(docs);
    } catch (err) {
        res.status(500).json({ error: "दस्तावेज़ सूची लाने में समस्या" });
    }
});

// Get one full document (with content) by id.
router.get("/:id", async (req, res) => {
    try {
        const doc = await Document.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: "दस्तावेज़ नहीं मिला" });
        res.json(doc);
    } catch (err) {
        res.status(500).json({ error: "दस्तावेज़ लाने में समस्या" });
    }
});

// Create a new document.
router.post("/", async (req, res) => {
    try {
        const { title, content, settings } = req.body;
        const doc = await Document.create({ title, content, settings: settings || {} });
        res.status(201).json(doc);
    } catch (err) {
        res.status(500).json({ error: "दस्तावेज़ बनाने में समस्या" });
    }
});

// Update (save) an existing document.
router.put("/:id", async (req, res) => {
    try {
        const { title, content, settings } = req.body;
        const doc = await Document.findByIdAndUpdate(
            req.params.id,
            { title, content, settings: settings || {} },
            { new: true }
        );
        if (!doc) return res.status(404).json({ error: "दस्तावेज़ नहीं मिला" });
        res.json(doc);
    } catch (err) {
        res.status(500).json({ error: "दस्तावेज़ सेव करने में समस्या" });
    }
});

// Delete a document.
router.delete("/:id", async (req, res) => {
    try {
        await Document.findByIdAndDelete(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: "दस्तावेज़ हटाने में समस्या" });
    }
});

// Duplicate an existing document: creates a brand-new document with
// the exact same content as the original (title gets " (कॉपी)"
// appended). The original document is never modified — this exists
// purely as a one-click safety copy against accidental deletion.
router.post("/:id/duplicate", async (req, res) => {
    try {
        const original = await Document.findById(req.params.id);
        if (!original) return res.status(404).json({ error: "दस्तावेज़ नहीं मिला" });
        const copy = await Document.create({
            title: (original.title || "बिना नाम") + " (कॉपी)",
            content: original.content,
            settings: original.settings || {}
        });
        res.status(201).json(copy);
    } catch (err) {
        res.status(500).json({ error: "कॉपी बनाने में समस्या" });
    }
});

// Move a document to the archive (or back out of it) — just flips the
// one flag; content/title/settings are untouched, and nothing is
// deleted. Kept as two small dedicated endpoints (rather than a
// generic "update archived field" route) so the intent is unambiguous
// from the URL alone.
router.put("/:id/archive", async (req, res) => {
    try {
        const doc = await Document.findByIdAndUpdate(req.params.id, { archived: true }, { new: true });
        if (!doc) return res.status(404).json({ error: "दस्तावेज़ नहीं मिला" });
        res.json(doc);
    } catch (err) {
        res.status(500).json({ error: "आर्काइव करने में समस्या" });
    }
});

router.put("/:id/unarchive", async (req, res) => {
    try {
        const doc = await Document.findByIdAndUpdate(req.params.id, { archived: false }, { new: true });
        if (!doc) return res.status(404).json({ error: "दस्तावेज़ नहीं मिला" });
        res.json(doc);
    } catch (err) {
        res.status(500).json({ error: "वापस लाने में समस्या" });
    }
});

module.exports = router;
