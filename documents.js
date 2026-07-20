const express = require("express");
const router = express.Router();
const Document = require("../models/Document");

// List all documents (title + updatedAt only — NOT full content, to
// keep the list fast even with many/large saved documents).
router.get("/", async (req, res) => {
    try {
        const docs = await Document.find({}, "title updatedAt").sort({ updatedAt: -1 });
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
        const { title, content } = req.body;
        const doc = await Document.create({ title, content });
        res.status(201).json(doc);
    } catch (err) {
        res.status(500).json({ error: "दस्तावेज़ बनाने में समस्या" });
    }
});

// Update (save) an existing document.
router.put("/:id", async (req, res) => {
    try {
        const { title, content } = req.body;
        const doc = await Document.findByIdAndUpdate(
            req.params.id,
            { title, content },
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

module.exports = router;