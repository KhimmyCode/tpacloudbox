const express = require('express');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const config = require('./config.json');

const app = express();
const uploadDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadDir);

app.use(express.json());
app.use(express.static('public'));

const safePath = (userPath = '') => {
    const baseDir = path.resolve(__dirname, config.uploadDir || 'uploads');
    const targetPath = path.resolve(baseDir, userPath);
    if (!targetPath.startsWith(baseDir)) {
        throw new Error('Unauthorized access');
    }
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

app.get('/api/check-admin', (req, res) => {
    res.json({ isAdmin: checkIsAdmin(req) });
});

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
                path: path.join(relPath, item.name),
                ext: path.extname(item.name).toLowerCase(),
                size: item.isDirectory() ? '--' : formatSize(stats.size),
                date: stats.mtime.toLocaleDateString('en-GB') + ' ' + stats.mtime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
            };
        }));
        res.json(data);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/search', async (req, res) => {
    try {
        const q = req.query.q.toLowerCase();
        const results = [];
        const scan = async (dir) => {
            const items = await fs.readdir(dir, { withFileTypes: true });
            for (const item of items) {
                const fullPath = path.join(dir, item.name);
                const relPath = path.relative(uploadDir, fullPath);
                if (item.name.toLowerCase().includes(q)) {
                    const stats = await fs.stat(fullPath);
                    results.push({
                        name: item.name,
                        isFolder: item.isDirectory(),
                        path: relPath.replace(/\\/g, '/'),
                        ext: path.extname(item.name).toLowerCase(),
                        size: item.isDirectory() ? '--' : formatSize(stats.size),
                        date: stats.mtime.toLocaleDateString('en-GB') + ' ' + stats.mtime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
                    });
                }
                if (item.isDirectory()) await scan(fullPath);
            }
        };
        await scan(uploadDir);
        res.json(results);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/rename', isAdmin, async (req, res) => {
    const { oldPath, newName } = req.body;
    const oldFull = safePath(oldPath);
    const newFull = path.join(path.dirname(oldFull), newName);
    await fs.move(oldFull, newFull);
    res.json({ success: true });
});

app.delete('/api/delete', isAdmin, async (req, res) => {
    await fs.remove(safePath(req.query.path));
    res.json({ success: true });
});

app.put('/api/move', isAdmin, async (req, res) => {
    const { source, destination } = req.body;
    const srcFull = safePath(source);
    const destFull = await getUniquePath(path.join(safePath(destination), path.basename(source)));
    await fs.move(srcFull, destFull);
    res.json({ success: true });
});

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.post('/api/upload', isAdmin, upload.array('files'), async (req, res) => {
    try {
        const targetFolder = safePath(req.body.path);
        const customNames = JSON.parse(req.body.names);

        for (let i = 0; i < req.files.length; i++) {
            let originalName = Buffer.from(req.files[i].originalname, 'latin1').toString('utf8');
            const originalExt = path.extname(originalName);

            let newName = customNames[i] || originalName;

            if (!path.extname(newName)) {
                newName += originalExt;
            }

            const finalPath = await getUniquePath(path.join(targetFolder, newName));
            await fs.writeFile(finalPath, req.files[i].buffer);
        }
        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).send(e.message); 
    }
});

app.post('/api/mkdir', isAdmin, async (req, res) => {
    await fs.ensureDir(safePath(req.body.path));
    res.json({ success: true });
});

app.get('/api/download', (req, res) => {
    try {
        const fullPath = safePath(req.query.path);
        if (!fs.existsSync(fullPath)) return res.status(404).send('File not found');

        const filename = path.basename(fullPath);
        const encodedName = encodeURIComponent(filename);
        
        // ใช้ mime-types เพื่อระบุประเภทไฟล์ให้ Browser รู้จัก
        const contentType = mime.lookup(fullPath) || 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        
        // --- จุดสำคัญ: เปลี่ยน inline เป็น attachment ---
        // attachment จะบังคับให้ Browser ดาวน์โหลดไฟล์ และจะเด้งหน้าต่างถามที่เก็บ (หากตั้งค่า Browser ไว้)
        res.setHeader('Content-Disposition', `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
        
        res.sendFile(fullPath);
    } catch (e) { 
        res.status(500).send('Error processing download'); 
    }
});

// API สำหรับ Preview (เปิดดูใน Browser)
app.get('/api/preview', (req, res) => {
    try {
        const fullPath = safePath(req.query.path);
        if (!fs.existsSync(fullPath)) return res.status(404).send('File not found');

        const filename = path.basename(fullPath);
        const encodedName = encodeURIComponent(filename);
        const contentType = mime.lookup(fullPath) || 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        // ใช้ inline เพื่อให้ Browser พยายาม Render ไฟล์แทนการดาวน์โหลด
        res.setHeader('Content-Disposition', `inline; filename="${encodedName}"; filename*=UTF-8''${encodedName}`);
        
        res.sendFile(fullPath);
    } catch (e) { 
        res.status(500).send('Error'); 
    }
});

app.listen(config.port, '0.0.0.0', () => console.log(`Server running at http://localhost:${config.port}`));