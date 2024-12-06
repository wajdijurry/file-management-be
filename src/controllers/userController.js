const User = require('../models/userModel');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

const FileService = require('../services/fileService');


exports.register = async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const user = new User({ username, email, password });
        await user.save();

        // Generate the user-specific directory path
        const userBasePath = path.join(FileService.uploadDirectory, user._id.toString());

        // Create the directory if it doesn't exist
        if (!fs.existsSync(userBasePath)) {
            fs.mkdirSync(userBasePath, { recursive: true });
        }

        res.status(201).json({ success: true, message: 'User registered successfully' });
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, error: 'Error registering user' });
    }
};

exports.login = async (req, res) => {
    try {
        const { username, password, rememberMe } = req.body;
        const user = await User.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        const tokenExpiry = rememberMe ? '7d' : '1h';

        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: tokenExpiry });

        res.status(200).json({ 
            success: true, 
            token, 
            username,
            userId: user._id.toString() 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Error logging in' });
    }
};
