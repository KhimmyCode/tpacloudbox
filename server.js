const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const config = require('./config.json');

const app = express();
const baseDir = path.resolve(__dirname, config.uploadDir || 'uploads');
fs.ensureDirSync(baseDir);

app.use(express.json());
app.use(express.static('public'));

// --- LOG SYSTEM ---
const logger = async (req, action, details) => {
    const ip = req.ip.replace('::ffff:', '') || 'unknown';
    const timestamp = new Date().toLocaleString('th-TH');
    const logEntry = `[${timestamp}] [IP: ${ip}] ${action.toUpperCase()}: ${details}`;
    
    console.log(logEntry); // แสดงใน Terminal
    try {
        await fs.appendFile(path.join(__dirname, 'activity.log'), logEntry + '\n'); // บันทึกลงไฟล์
    } catch (err) {
        console.error('Logging Error:', err);
    }
};

// --- CORE FUNCTIONS ---
const safePath = (userPath = '') => {
    const cleanUserPath = decodeURIComponent(userPath).replace(/^[\/\\]+/, '');
    const targetPath = path.join(baseDir, cleanUserPath);
    if (!targetPath.startsWith(baseDir)) throw new Error('Unauthorized access');
    return targetPath;
};

const getUniquePath = async (targetPath) => {
    let { dir, name, ext } = path.parse(targetPath);
    let finalPath = targetPath;
    let counter = 1;
    while (await fs.pathExists(finalPath)) {
        finalPath = path.join(dir, `${name} (${counter})${ext}`);
        counter++;
    }
    return finalPath;
};

const formatSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const checkIsAdmin = (req) => {
    const clientIp = req.ip.replace('::ffff:', '');
    return config.adminIps.includes(clientIp) || clientIp === '127.0.0.1' || clientIp === '::1';
};

const isAdmin = (req, res, next) => {
    if (checkIsAdmin(req)) return next();
    res.status(403).json({ error: 'Admin Access Denied' });
};

// --- API ENDPOINTS ---
app.get('/api/check-admin', (req, res) => res.json({ isAdmin: checkIsAdmin(req) }));

app.get('/api/files', async (req, res) => {
    try {
        const relPath = req.query.path || '';
        const target = safePath(relPath);
        const locked = config.lockedFolders.find(f => f.folderName === relPath);
        if (locked && req.query.pin !== locked.pin) return res.status(401).json({ locked: true });

        const items = await fs.readdir(target, { withFileTypes: true });
        const data = await Promise.all(items.map(async (item) => {
            const fullPath = path.join(target, item.name);
            const stats = await fs.stat(fullPath);
            return {
                name: item.name,
                isFolder: item.isDirectory(),
                path: path.join(relPath, item.name).replace(/\\/g, '/'),
                ext: path.extname(item.name).toLowerCase(),
                size: item.isDirectory() ? '--' : formatSize(stats.size),
                date: stats.mtime.toLocaleString('th-TH')
            };
        }));
        res.json(data);
    } catch (e) { res.status(500).send(e.message); }
});

app.put('/api/rename', isAdmin, async (req, res) => {
    try {
        const { oldPath, newName } = req.body;
        const oldFull = safePath(oldPath);
        const newFull = path.join(path.dirname(oldFull), newName);
        await fs.move(oldFull, newFull);
        await logger(req, 'RENAME', `${oldPath} -> ${newName}`);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

app.delete('/api/delete', isAdmin, async (req, res) => {
    try {
        const p = req.query.path;
        await fs.remove(safePath(p));
        await logger(req, 'DELETE', p);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

app.put('/api/move', isAdmin, async (req, res) => {
    try {
        const { source, destination } = req.body;
        const srcFull = safePath(source);
        const destFull = await getUniquePath(path.join(safePath(destination), path.basename(source)));
        await fs.move(srcFull, destFull);
        await logger(req, 'MOVE', `${source} TO ${destination}`);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

const upload = multer({ storage: multer.memoryStorage() });
app.post('/api/upload', isAdmin, upload.array('files'), async (req, res) => {
    try {
        const targetFolder = safePath(req.body.path);
        const customNames = JSON.parse(req.body.names || "[]");
        let uploadedFiles = [];

        for (let i = 0; i < req.files.length; i++) {
            let originalName = Buffer.from(req.files[i].originalname, 'latin1').toString('utf8');
            let newName = customNames[i] || originalName;
            if (!path.extname(newName)) newName += path.extname(originalName);

            const finalPath = await getUniquePath(path.join(targetFolder, newName));
            await fs.writeFile(finalPath, req.files[i].buffer);
            uploadedFiles.push(path.basename(finalPath));
        }
        await logger(req, 'UPLOAD', `Folder: ${req.body.path || 'Root'}, Files: ${uploadedFiles.join(', ')}`);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/mkdir', isAdmin, async (req, res) => {
    try {
        await fs.ensureDir(safePath(req.body.path));
        await logger(req, 'MKDIR', req.body.path);
        res.json({ success: true });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/download', async (req, res) => {
    try {
        const fullPath = safePath(req.query.path);
        if (!fs.existsSync(fullPath)) return res.status(404).send('Not Found');

        const encodedName = encodeURIComponent(path.basename(fullPath));
        res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
        
        await logger(req, 'DOWNLOAD', req.query.path);
        res.sendFile(fullPath);
    } catch (e) { res.status(500).send('Error'); }
});

const PORT = config.port || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📝 Activity log is being saved to activity.log`);
});