import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import httpProxy from 'http-proxy';
import http from 'http';
import path from 'path';
import fs from 'fs-extra';
import { DockerManager } from './DockerManager';
import { RuntimeDetector } from './RuntimeDetector';
import { ProjectDB } from './ProjectDB';

const app = express();
const server = http.createServer(app);
const proxy = httpProxy.createProxyServer({ ws: true }); // enable WebSocket proxying for HMR
const dockerManager = new DockerManager();

app.use(cors());
app.use(express.json());

const PROJECTS_DIR = path.join(__dirname, '../projects');
fs.ensureDirSync(PROJECTS_DIR);

// ── In-Memory Cache (fast path for hot requests) ──
// SQLite (ProjectDB) is the persistent source of truth.
// This map mirrors the DB for latency-sensitive proxy lookups.
const projectContainers: Record<string, {
    ip: string;
    lastSeen: number;
    status: 'starting' | 'ready' | 'running' | 'error';
    logs: string[];
    runtime?: import('./RuntimeDetector').RuntimeConfig;
    port?: number;
}> = {};

// Restore in-memory state from DB on cold start
(async () => {
    const existing = ProjectDB.getByStatus('running');
    existing.forEach(p => {
        ProjectDB.setStatus(p.projectId, 'error');
    });
})();

// ── Vite Asset Catch-All (Referer-based) ─────────────────────────────────────
// Vite injects /@vite/client, /@react-refresh, /src/*, /node_modules/* with
// ABSOLUTE paths (root of the origin). The browser fetches them from localhost:4000
// without the /preview/:id prefix. We use the Referer header to identify which
// container the user is viewing and proxy the request there.
app.use((req: any, res: any, next: any) => {
    // Only intercept Vite/dev-server asset paths
    const isViteAsset =
        req.path.startsWith('/@') ||
        req.path.startsWith('/src/') ||
        req.path.startsWith('/node_modules/') ||
        req.path.startsWith('/__vite') ||
        req.path.endsWith('.tsx') ||
        req.path.endsWith('.ts') ||
        req.path.endsWith('.jsx');

    if (!isViteAsset) return next();

    // Extract projectId from Referer header
    const referer = req.headers.referer || req.headers.referrer || '';
    const match = referer.match(/\/preview\/([a-f0-9\-]{36})/);
    if (!match) return next();

    const projectId = match[1];
    const container = projectContainers[projectId];
    if (!container?.port) return next();

    const target = `http://127.0.0.1:${container.port}${req.url}`;
    console.log(`[vite-asset] ${req.method} ${req.path} → project ${projectId.slice(0, 8)} (localhost:${container.port})`);

    proxy.web(req, res, { target, changeOrigin: true }, (err: any) => {
        if (!res.headersSent) res.status(502).send(`Vite asset proxy error: ${err?.message}`);
    });
});

// ── WebSocket Upgrade for Vite HMR ───────────────────────────────────────────
// Vite's HMR uses WebSockets — we need to upgrade the connection
server.on('upgrade', (req: any, socket: any, head: any) => {
    const referer = req.headers.referer || '';
    const match = referer.match(/\/preview\/([a-f0-9\-]{36})/);
    if (!match) { socket.destroy(); return; }

    const projectId = match[1];
    const container = projectContainers[projectId];
    if (!container?.port) { socket.destroy(); return; }

    console.log(`[HMR-ws] upgrade → project ${projectId.slice(0, 8)} (localhost:${container.port})`);
    proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${container.port}`, changeOrigin: true });
});

// SSE endpoint for streaming logs to frontend
app.get('/api/projects/:projectId/logs', (req, res) => {
    const { projectId } = req.params;
    const project = projectContainers[projectId];
    if (!project) {
        return res.status(404).json({ error: 'Project not found' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let lastLogIndex = 0;
    let lastStatus = '';

    const sendUpdates = () => {
        // Send new logs
        if (project.logs.length > lastLogIndex) {
            for (let i = lastLogIndex; i < project.logs.length; i++) {
                res.write(`data: ${JSON.stringify({ log: project.logs[i] })}\n\n`);
            }
            lastLogIndex = project.logs.length;
        }

        // Send status change
        if (project.status !== lastStatus) {
            res.write(`data: ${JSON.stringify({ status: project.status })}\n\n`);
            lastStatus = project.status;
        }
    };

    // Send initial state
    sendUpdates();

    // Keep checking for updates
    const interval = setInterval(sendUpdates, 1000);

    req.on('close', () => {
        clearInterval(interval);
    });
});

// 1. Create and Start Project

// ── Port Allocator ──────────────────────────────────────────────────────────
// Ports in range [BASE_PORT, BASE_PORT + 2000). Each project gets a unique one.
const BASE_PORT = 3100;

function allocateHostPort(): number {
    const used = ProjectDB.getUsedHostPorts();
    // Also add any ports in the current in-memory map to handle race conditions
    for (const c of Object.values(projectContainers)) {
        if ((c as any).hostPort) used.add((c as any).hostPort);
    }
    for (let port = BASE_PORT; port < BASE_PORT + 2000; port++) {
        if (!used.has(port)) return port;
    }
    throw new Error('No available host ports in range');
}

app.post('/api/projects/start', async (req, res) => {
    const { files } = req.body;
    console.log('Received files:', files?.length);
    if (!files || !Array.isArray(files)) {
        return res.status(400).json({ error: 'Files are required' });
    }

    const projectId = uuidv4();
    const projectPath = path.join(PROJECTS_DIR, projectId);

    // Initialize in-memory cache
    const hostPort = allocateHostPort();
    const containerPort = 3000; // Projects always serve on port 3000 internally
    projectContainers[projectId] = {
        ip: '',
        lastSeen: Date.now(),
        status: 'starting',
        logs: [],
        port: hostPort,  // exposed host port
    } as any;

    // Persist to SQLite immediately (with unique host port reserved)
    const runtimeEarly = RuntimeDetector.detect(files);
    ProjectDB.create({
        projectId,
        status: 'starting',
        hostPort,
        containerPort,
        containerIp: '',
        runtimeType: runtimeEarly.type,
        startCommand: runtimeEarly.startCommand,
    });

    const addLog = (log: string) => {
        const timestamp = new Date().toLocaleTimeString();
        projectContainers[projectId].logs.push(`[${timestamp}] ${log}`);
        console.log(`[${projectId}] ${log}`);

        // Notify SSE listeners of new logs and current status
        const status = projectContainers[projectId].status;
        // This is a bit hacky but index.ts doesn't have an easy way to emit to the SSE res objects directly without a custom emitter
        // We'll rely on the SSE endpoint re-sending status periodically or when a new log arrives.
    };

    try {
        // Detect Runtime
        const runtime = RuntimeDetector.detect(files);
        addLog(`Detected runtime: ${runtime.type}`);

        // Create Project Staging Area
        await fs.ensureDir(projectPath);
        for (const file of files) {
            const filePath = path.join(projectPath, file.path);
            await fs.ensureDir(path.dirname(filePath));
            await fs.writeFile(filePath, file.content);
        }
        addLog(`Created ${files.length} project files`);

        // Create and Start Container — with host port binding
        addLog(`Creating container with image: ${runtime.image} → host port ${hostPort}:${containerPort}`);
        await dockerManager.createContainer({
            id: projectId,
            image: runtime.image,
            memory: 512 * 1024 * 1024,
            cpu: 0.5,
            hostPort,
            containerPort,
        });

        await dockerManager.startContainer(projectId);
        addLog(`Container started → accessible at localhost:${hostPort}`);

        // Copy Files to Container
        await dockerManager.copyToContainer(projectId, projectPath, '/app');
        addLog('Files copied to container');

        // ── Step 1: Install dependencies (SYNCHRONOUS with live logs) ──
        if (runtime.installCommand.length > 0) {
            const installCmd = runtime.installCommand.join(' ');
            addLog(`⏳ Installing dependencies: ${installCmd}`);

            // execCommand is synchronous — it blocks until the process exits
            // and streams every line of output via addLog in real-time
            const exitCode = await dockerManager.execCommand(
                projectId,
                runtime.installCommand,
                (line) => addLog(line.trim()),
            );

            if (exitCode === 0) {
                addLog('✅ Dependencies installed successfully');
            } else {
                addLog(`⚠️  Install exited with code ${exitCode} — continuing anyway`);
            }
        }

        // ── Step 2: Mark Setup Complete ──
        projectContainers[projectId] = {
            ...projectContainers[projectId],
            status: 'ready',
            runtime,
            lastSeen: Date.now(),
        };

        // Persist ready state to DB (no need to update IP; we use localhost)
        ProjectDB.updateRuntime(projectId, 'ready', '127.0.0.1');

        res.json({
            projectId,
            previewUrl: `/preview/${projectId}/`,
            status: 'ready',
        });

    } catch (error: any) {
        console.error('Failed to setup project:', error);
        addLog(`Error: ${error.message}`);
        if (projectContainers[projectId]) {
            projectContainers[projectId].status = 'error';
        }
        ProjectDB.setStatus(projectId, 'error');
        res.status(500).json({ error: error.message });
    }
});

// 2. Dynamic Preview Proxy - handles lazy-starting, port discovery, and DB recovery
// Note: wildcard '*' routes require Express 5; we register both forms for compatibility
app.all('/preview/:projectId', async (req: any, res: any) => handlePreview(req, res));
// app.all('/preview/:projectId/*', async (req: any, res: any) => handlePreview(req, res));

async function handlePreview(req: any, res: any) {
    const projectId = req.params.projectId;
    let container = projectContainers[projectId];

    // ── DB-based Recovery ──────────────────────────────────────────────────
    // If container was lost from memory (server restart, etc.), reconstruct from DB
    if (!container) {
        const dbRecord = ProjectDB.get(projectId);
        if (!dbRecord || dbRecord.status === 'stopped') {
            return res.status(404).send(`Project ${projectId} not found or was stopped.`);
        }

        console.log(`[${projectId}] Recovering container from DB (status: ${dbRecord.status})...`);

        // Rebuild in-memory entry from DB record
        const startCmd: string[] = (() => {
            try { return JSON.parse(dbRecord.startCommand as unknown as string); } catch { return ['bun', 'run', 'dev']; }
        })();

        projectContainers[projectId] = {
            ip: dbRecord.containerIp || '127.0.0.1',
            lastSeen: Date.now(),
            status: 'ready', // Force re-start via lazy-start logic below
            logs: [`[RECOVERED] Container recovered from DB`],
            runtime: {
                type: dbRecord.runtimeType as any,
                installCommand: [],
                startCommand: startCmd,
                image: dbRecord.runtimeType === 'python' ? 'coder-python' : 'coder-node',
                packageManager: 'bun',
            },
            port: dbRecord.hostPort ?? undefined,
        };
        container = projectContainers[projectId];
    }

    container.lastSeen = Date.now();
    ProjectDB.touch(projectId);

    // ── Lazy Start Logic ───────────────────────────────────────────────────
    const needsStart = container.status === 'ready' ||
        (container.status === 'running' && container.port &&
            !(await dockerManager.isProcessRunning(projectId, container.runtime?.startCommand[0] || '').catch(() => false)));

    if (needsStart && container.runtime) {
        console.log(`[${projectId}] Lazy-starting server (status: ${container.status})...`);
        container.status = 'starting';
        container.port = undefined;

        // Build the start command — inject --base for Vite so HMR assets resolve correctly
        let startCmd = [...container.runtime.startCommand];
        const isViteProject = container.runtime.type === 'node';
        if (isViteProject) {
            // Append vite-specific flags so HMR assets are served under /preview/:projectId/
            // This fixes /@vite/client, /@react-refresh, /src/main.tsx requests going to root
            if (startCmd.join(' ').includes('vite') || startCmd.join(' ').includes('dev')) {
                startCmd = ['sh', '-c',
                    `${startCmd.join(' ')} --host 0.0.0.0 --base=/preview/${projectId}/ 2>&1 | tee /tmp/server.log`
                ];
            }
        }

        // Start tailing logs
        dockerManager.tailLogs(projectId, '/tmp/server.log', (line) => {
            const trimmed = line.trim();
            if (trimmed) {
                container.logs.push(trimmed);
                if (container.logs.length > 1000) container.logs.shift();
            }
        }).catch(() => { });

        // Execute start command in background (non-blocking)
        dockerManager.execCommandBackground(projectId, startCmd).catch(err => {
            console.error(`[${projectId}] Failed to start server:`, err);
            container.status = 'error';
            ProjectDB.setStatus(projectId, 'error');
        });
    }

    // ── Wait for Server to be Reachable ───────────────────────────────────
    if (container.status === 'starting') {
        const dbRecord = ProjectDB.get(projectId);
        const hostPort = dbRecord?.hostPort ?? (container as any).port ?? 3100;
        console.log(`[${projectId}] Waiting for server on localhost:${hostPort}...`);

        const net = require('net');
        const deadline = Date.now() + 90000;
        let serverUp = false;

        while (Date.now() < deadline && !serverUp) {
            await new Promise<void>(resolve => {
                const sock = new net.Socket();
                const cleanup = () => { try { sock.destroy(); } catch { } resolve(); };
                sock.setTimeout(800);
                sock.on('connect', () => { serverUp = true; cleanup(); });
                sock.on('error', cleanup);
                sock.on('timeout', cleanup);
                sock.connect(hostPort, '127.0.0.1');
            });
            if (!serverUp) await new Promise(r => setTimeout(r, 500));
        }

        container.status = 'running';
        container.port = hostPort;
        ProjectDB.updateRuntime(projectId, 'running', '127.0.0.1');

        if (serverUp) {
            console.log(`[${projectId}] ✅ Server ready on localhost:${hostPort}`);
        } else {
            console.log(`[${projectId}] ⚠️ Timeout — proxying to localhost:${hostPort} anyway`);
        }
    }

    if (container.status === 'error') {
        return res.status(500).send(`
      <html><body style="font-family:monospace;padding:2rem;background:#111;color:#f55">
        <h2>⚠️ Project Error</h2>
        <p>The project server failed to start. Check the logs for details.</p>
        <pre>${container.logs.slice(-20).join('\n')}</pre>
      </body></html>`);
    }

    // ── Proxy the Request ─────────────────────────────────────────────────
    const dbRec = ProjectDB.get(projectId);
    const hostPort = dbRec?.hostPort ?? container.port ?? 3100;

    // Strip /preview/:projectId prefix — forward the rest as-is to the container
    const prefix = `/preview/${projectId}`;
    const pathPart = req.url.startsWith(prefix)
        ? req.url.slice(prefix.length) || '/'
        : req.url; // fallback: pass raw (shouldn't happen with correct route)

    const target = `http://127.0.0.1:${hostPort}${pathPart}`;
    console.log(`[${projectId}] → ${req.method} ${pathPart} (localhost:${hostPort})`);

    proxy.web(req, res, { target, changeOrigin: true }, (err: any) => {
        if (!res.headersSent) {
            res.status(502).send(`Gateway Error: Container not responding on localhost:${hostPort}. Error: ${err?.message}`);
        }
    });
}

// ─── Admin: List all projects ──────────────────────────────────────────────
app.get('/api/projects', (_req, res) => {
    const projects = ProjectDB.getAll().map(p => ({
        projectId: p.projectId,
        createdAt: new Date(p.createdAt).toISOString(),
        lastSeen: new Date(p.lastSeen).toISOString(),
        status: p.status,
        hostPort: p.hostPort,
        containerPort: p.containerPort,
        containerIp: p.containerIp,
        runtimeType: p.runtimeType,
        startCommand: (() => { try { return JSON.parse(p.startCommand as unknown as string); } catch { return []; } })(),
        isActive: !!projectContainers[p.projectId],
    }));
    res.json({ total: projects.length, projects });
});

// ─── Admin: Get single project ─────────────────────────────────────────────
app.get('/api/projects/:projectId', (req, res) => {
    const { projectId } = req.params;
    const record = ProjectDB.get(projectId);
    if (!record) return res.status(404).json({ error: 'Not found' });
    const cached = projectContainers[projectId];
    res.json({
        ...record,
        createdAt: new Date(record.createdAt).toISOString(),
        lastSeen: new Date(record.lastSeen).toISOString(),
        startCommand: (() => { try { return JSON.parse(record.startCommand as unknown as string); } catch { return []; } })(),
        logsCount: cached?.logs.length ?? 0,
        isActive: !!cached,
    });
});

// ─── Admin: Stop and delete a project ─────────────────────────────────────
app.delete('/api/projects/:projectId', async (req, res) => {
    const { projectId } = req.params;
    try {
        ProjectDB.setStatus(projectId, 'stopped');
        await dockerManager.stopContainer(projectId).catch(() => { });
        delete projectContainers[projectId];
        ProjectDB.remove(projectId);
        await fs.remove(path.join(PROJECTS_DIR, projectId)).catch(() => { });
        res.json({ success: true, projectId });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 3. Auto-Cleanup Inactive Containers
setInterval(async () => {
    const timeout = 60 * 60 * 1000; // 60 minutes
    const now = Date.now();

    for (const [id, data] of Object.entries(projectContainers)) {
        if (now - data.lastSeen > timeout) {
            console.log(`Cleaning up inactive container ${id}`);
            ProjectDB.setStatus(id, 'stopped');
            await dockerManager.stopContainer(id);
            delete projectContainers[id];
            await fs.remove(path.join(PROJECTS_DIR, id)).catch(() => { });
        }
    }
}, 60000);

const PORT = process.env.PORT || 4000;

async function start() {
    try {
        const docker = new (require('dockerode'))();

        // Build/Check Coder Node Image
        try {
            await docker.getImage('coder-node').inspect();
            console.log('coder-node image already exists.');
        } catch {
            console.log('Building coder-node image...');
            await dockerManager.buildWorkerImage(path.join(__dirname, '../node.Dockerfile'), 'coder-node');
        }

        // Build/Check Coder Python Image
        try {
            await docker.getImage('coder-python').inspect();
            console.log('coder-python image already exists.');
        } catch {
            console.log('Building coder-python image...');
            await dockerManager.buildWorkerImage(path.join(__dirname, '../python.Dockerfile'), 'coder-python');
        }

        server.listen(PORT, () => {
            console.log(`Orchestrator running on port ${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start orchestrator:', err);
        process.exit(1);
    }
}

start();
