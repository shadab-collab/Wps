const mongoose = require("mongoose");

// Deliberately minimal: title + the full saved HTML content of the
// editor's pages, plus automatic createdAt/updatedAt timestamps.
const documentSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            default: "बिना नाम"
        },
        content: {
            type: String, // innerHTML of #pages-container
            default: ""
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Document", documentSchema);