let currentPath = '';
let isAdmin = false;
let queueFiles = [];
let searchTimeout = null;

/**
 * 1. App Initialization
 */
async function init() {
    await checkAdmin();
    loadFiles(''); // Start at root
    setupGlobalDragDrop();
    lucide.createIcons();
}

/**
 * 2. Admin & Auth Check
 */
async function checkAdmin() {
    try {
        const res = await fetch('/api/check-admin');
        const data = await res.json();
        isAdmin = data.isAdmin;
        if (isAdmin) {
            document.getElementById('admin-actions').classList.remove('hidden');
            const badge = document.getElementById('admin-badge');
            badge.innerText = 'Administrator';
            badge.classList.add('admin');
        }
    } catch (e) {
        console.error("Connectivity issue: Could not verify admin status.");
    }
}

/**
 * 3. File Explorer Logic (Loading & Rendering)
 */
async function loadFiles(path) {
    try {
        const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error('Failed to load files');
        
        const items = await res.json();
        renderGrid(items);
        currentPath = path;
        updateBreadcrumb();
    } catch (err) {
        console.error(err);
    }
}

function renderGrid(items) {
    const grid = document.getElementById('file-grid');
    grid.innerHTML = '';
    
    if (!items || items.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 100px; color: #94A3B8;">
                <i data-lucide="folder-open" size="48"></i>
                <p style="margin-top: 15px; font-size: 16px;">This folder is empty</p>
            </div>`;
        lucide.createIcons();
        return;
    }

    items.forEach(item => {
        const card = document.createElement('div');
        card.className = `file-card ${item.isFolder ? 'folder' : 'file'}`;
        
        // --- Internal Drag & Drop (Move logic) ---
        if (isAdmin) {
            card.draggable = true;
            card.ondragstart = (e) => e.dataTransfer.setData('sourcePath', item.path);
            
            if (item.isFolder) {
                card.ondragover = (e) => { 
                    e.preventDefault(); 
                    card.classList.add('drop-target'); 
                };
                card.ondragleave = () => card.classList.remove('drop-target');
                card.ondrop = async (e) => {
                    e.preventDefault();
                    card.classList.remove('drop-target');
                    const source = e.dataTransfer.getData('sourcePath');
                    if (source && source !== item.path) {
                        moveItem(source, item.path);
                    }
                };
            }
        }

        // --- Icon & Colors ---
        const isPdf = item.ext === '.pdf';
        const iconName = item.isFolder ? 'folder' : (isPdf ? 'file-text' : 'file');
        const iconColor = item.isFolder ? '#FFB347' : (isPdf ? '#FF4B2B' : '#3B82F6');

        card.innerHTML = `
            <div class="card-actions">
                ${isAdmin ? `
                    <button class="btn-icon" title="Rename" onclick="renameItem('${item.path}', '${item.name}', event)">
                        <i data-lucide="edit-3" size="14"></i>
                    </button>
                    <button class="btn-icon del" title="Delete" onclick="deleteItem('${item.path}', event)">
                        <i data-lucide="trash-2" size="14"></i>
                    </button>
                ` : ''}
            </div>
            <div style="color: ${iconColor}; margin-bottom: 14px;">
                <i data-lucide="${iconName}" size="48"></i>
            </div>
            <div class="file-name" title="${item.name}">${item.name}</div>
            <span class="file-meta">${item.size} • ${item.date}</span>
            ${!item.isFolder ? `
                <button class="btn-download" onclick="download('${item.path}', event)">
                    Download
                </button>` : ''}
        `;
        
        card.onclick = () => item.isFolder && loadFiles(item.path);
        grid.appendChild(card);
    });
    lucide.createIcons();
}

/**
 * 4. Admin Operations (Rename, Delete, Move)
 */
async function deleteItem(path, e) {
    e.stopPropagation();
    if (!confirm(`Are you sure you want to delete this ${path.includes('.') ? 'file' : 'folder'}?`)) return;
    
    const res = await fetch(`/api/delete?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    if (res.ok) loadFiles(currentPath);
}

async function renameItem(oldPath, oldName, e) {
    e.stopPropagation();
    const newName = prompt('Enter new name (including extension):', oldName);
    if (!newName || newName === oldName) return;
    
    const res = await fetch('/api/rename', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ oldPath, newName })
    });
    if (res.ok) loadFiles(currentPath);
}

async function moveItem(source, destination) {
    const res = await fetch('/api/move', {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ source, destination })
    });
    if (res.ok) loadFiles(currentPath);
}

/**
 * 5. Persistent Upload Queue (Draft Logic)
 */
function processFiles(files) {
    if (!isAdmin) return;
    const newFiles = Array.from(files);
    queueFiles = [...queueFiles, ...newFiles];
    updateQueueUI();
}

function updateQueueUI() {
    const queueDiv = document.getElementById('upload-queue');
    const list = document.getElementById('draft-list');
    
    if (queueFiles.length > 0) {
        queueDiv.classList.remove('hidden');
        list.innerHTML = queueFiles.map((f, i) => `
            <div class="draft-item">
                <i data-lucide="file-up" size="16" style="color: var(--orange)"></i>
                <input type="text" value="${f.name}" id="q-name-${i}" placeholder="Edit filename...">
                <i data-lucide="x" size="16" style="cursor: pointer; color: #94A3B8" onclick="removeFromQueue(${i})"></i>
            </div>
        `).join('');
        document.getElementById('queue-count').innerText = queueFiles.length;
        lucide.createIcons();
    } else {
        queueDiv.classList.add('hidden');
    }
}

function removeFromQueue(index) {
    queueFiles.splice(index, 1);
    updateQueueUI();
}

function clearQueue() {
    queueFiles = [];
    updateQueueUI();
}

async function startFinalUpload() {
    if (queueFiles.length === 0) return;

    const formData = new FormData();
    // Gather drafted names from the input fields
    const names = queueFiles.map((_, i) => document.getElementById(`q-name-${i}`).value);
    
    formData.append('path', currentPath);
    formData.append('names', JSON.stringify(names));
    queueFiles.forEach(f => formData.append('files', f));

    // Show loading state (optional)
    const btn = document.querySelector('.btn-primary-sm');
    btn.innerText = "Uploading...";
    btn.disabled = true;

    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    
    if (res.ok) {
        clearQueue();
        loadFiles(currentPath);
    } else {
        alert("Upload failed. Check server logs.");
    }
    btn.innerText = "Upload All";
    btn.disabled = false;
}

/**
 * 6. Search Logic (Fixed for Metadata compatibility)
 */
function handleSearch(q) {
    clearTimeout(searchTimeout);
    
    if (!q.trim()) { 
        loadFiles(currentPath); 
        return; 
    }

    searchTimeout = setTimeout(async () => {
        try {
            const grid = document.getElementById('file-grid');
            grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; padding:50px;">Searching through all folders...</div>';

            const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
            if (!res.ok) throw new Error('Search failed');
            
            const results = await res.json();
            renderGrid(results);

            // Update Breadcrumb UI for Search state
            const bc = document.getElementById('breadcrumb');
            bc.innerHTML = `
                <span class="bc-item" onclick="loadFiles('')">Home</span> 
                <span style="color: #CBD5E1">/</span> 
                <span>Search results for: "<b>${q}</b>"</span>
                <span onclick="loadFiles(currentPath)" style="margin-left: 15px; cursor: pointer; color: var(--orange); font-size: 12px; font-weight: 600;">[Close Search]</span>
            `;
        } catch (err) {
            console.error(err);
        }
    }, 400); // 400ms delay to prevent excessive API calls
}

/**
 * 7. Global Drag & Drop (External files to Queue)
 */
function setupGlobalDragDrop() {
    const area = document.getElementById('drop-area');
    
    area.ondragover = (e) => { 
        e.preventDefault(); 
        if (isAdmin) area.classList.add('drop-target'); 
    };
    
    area.ondragleave = () => area.classList.remove('drop-target');
    
    area.ondrop = (e) => {
        e.preventDefault();
        area.classList.remove('drop-target');
        if (isAdmin && e.dataTransfer.files.length > 0) {
            processFiles(e.dataTransfer.files);
        }
    };
}

/**
 * 8. UI Helpers
 */
function download(p, e) {
    e.stopPropagation(); // Prevent folder opening
    window.location.href = `/api/download?path=${encodeURIComponent(p)}`;
}

async function createNewFolder() {
    const name = prompt("Enter new folder name:");
    if (!name) return;
    
    const fullPath = currentPath ? `${currentPath}/${name}` : name;
    const res = await fetch('/api/mkdir', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ path: fullPath })
    });
    
    if (res.ok) loadFiles(currentPath);
}

function updateBreadcrumb() {
    const bc = document.getElementById('breadcrumb');
    bc.innerHTML = `<span class="bc-item" onclick="loadFiles('')">Home</span>`;
    
    if (!currentPath) return;
    
    const parts = currentPath.split(/[/\\]/).filter(p => p);
    let cumulativePath = '';
    
    parts.forEach(p => {
        cumulativePath += (cumulativePath ? '/' : '') + p;
        const target = cumulativePath;
        bc.innerHTML += `
            <span style="color: #CBD5E1">/</span> 
            <span class="bc-item" onclick="loadFiles('${target.replace(/'/g, "\\'")}')">${p}</span>
        `;
    });
}



// Start the application
window.onload = init;