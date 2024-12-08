const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
    name: { type: String, required: true },
    path: { type: String, required: true },
    mimetype: { type: String },
    size: { type: Number },
    userId: { type: String, required: true },
    parent_id: { type: String, default: null },
    deleted: { type: Boolean, default: false },
    isPasswordProtected: { type: Boolean, default: false },
    password: { type: String, select: false }, // Will not be included in queries by default
    lastAccessed: { type: Date },
    userAccess: [{
        userId: { type: String, required: true },
        lastAccessed: { type: Date, required: true }
    }],
    createdAt: { type: Date, default: Date.now }
});

// Add index for faster queries
fileSchema.index({ userId: 1, parent_id: 1, deleted: 1 });

// Middleware to check and reset lastAccessed if more than 1 hour old
fileSchema.pre('save', function(next) {
    if (this.lastAccessed) {
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000); // 1 hour in milliseconds
        if (this.lastAccessed < oneHourAgo) {
            this.lastAccessed = null;
        }
    }
    next();
});

module.exports = mongoose.model('File', fileSchema);