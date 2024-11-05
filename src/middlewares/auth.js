const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(403).json({ success: false, error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1]; // Extract the token after 'Bearer'
    if (!token) {
        return res.status(403).json({ success: false, error: 'Token is malformed' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
            console.log(token, err);
            return res.status(500).json({ success: false, error: 'Failed to authenticate token' });
        }
        req.userId = decoded.userId;
        next();
    });
};