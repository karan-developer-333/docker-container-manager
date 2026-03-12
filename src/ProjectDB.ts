import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProjectStatus = 'starting' | 'ready' | 'running' | 'error' | 'stopped';

export interface ProjectRecord {
    projectId: string;
    createdAt: number;          // Unix timestamp (ms)
    status: ProjectStatus;
    hostPort: number | null;    // Port exposed on the HOST machine (e.g. 3101, 3102)
    containerPort: number;      // Port inside container (typically 3000, 5173)
    containerIp: string;
    runtimeType: string;        // 'node' | 'python' | 'static'
    startCommand: string;       // JSON-serialised string[]
    lastSeen: number;           // Unix timestamp (ms) of last HTTP access
}

// ─── Singleton DB ────────────────────────────────────────────────────────────

const DB_DIR = path.join(__dirname, '../data');
const DB_PATH = path.join(DB_DIR, 'projects.db');

fs.ensureDirSync(DB_DIR);

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent-read performance
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    projectId     TEXT     PRIMARY KEY,
    createdAt     INTEGER  NOT NULL,
    status        TEXT     NOT NULL DEFAULT 'starting',
    hostPort      INTEGER  UNIQUE,           -- exposed on host machine
    containerPort INTEGER  NOT NULL DEFAULT 3000,
    containerIp   TEXT     NOT NULL DEFAULT '',
    runtimeType   TEXT     NOT NULL DEFAULT 'node',
    startCommand  TEXT     NOT NULL DEFAULT '[]',
    lastSeen      INTEGER  NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_projects_status   ON projects(status);
  CREATE INDEX IF NOT EXISTS idx_projects_lastSeen ON projects(lastSeen);
  CREATE INDEX IF NOT EXISTS idx_projects_hostPort ON projects(hostPort);
`);

// ─── Prepared Statements ─────────────────────────────────────────────────────

const stmtInsert = db.prepare(`
  INSERT INTO projects (projectId, createdAt, status, hostPort, containerPort, containerIp, runtimeType, startCommand, lastSeen)
  VALUES (@projectId, @createdAt, @status, @hostPort, @containerPort, @containerIp, @runtimeType, @startCommand, @lastSeen)
`);

const stmtUpdateStatus = db.prepare(`
  UPDATE projects SET status = @status WHERE projectId = @projectId
`);

const stmtUpdateRuntime = db.prepare(`
  UPDATE projects
  SET status = @status, containerIp = @containerIp, lastSeen = @lastSeen
  WHERE projectId = @projectId
`);

const stmtUpdateLastSeen = db.prepare(`
  UPDATE projects SET lastSeen = @lastSeen WHERE projectId = @projectId
`);

const stmtGetById = db.prepare(`
  SELECT * FROM projects WHERE projectId = ?
`);

const stmtGetAll = db.prepare(`
  SELECT * FROM projects ORDER BY createdAt DESC
`);

const stmtGetByStatus = db.prepare(`
  SELECT * FROM projects WHERE status = ? ORDER BY createdAt DESC
`);

const stmtGetUsedPorts = db.prepare(`
  SELECT hostPort FROM projects WHERE hostPort IS NOT NULL AND status != 'stopped'
`);

const stmtDelete = db.prepare(`
  DELETE FROM projects WHERE projectId = ?
`);

const stmtGetInactive = db.prepare(`
  SELECT projectId FROM projects WHERE lastSeen < ? AND status != 'stopped'
`);

// ─── Public API ──────────────────────────────────────────────────────────────

export class ProjectDB {
    /**
     * Insert a new project record when a container is first created.
     */
    static create(record: {
        projectId: string;
        status: ProjectStatus;
        hostPort: number;
        containerPort: number;
        containerIp: string;
        runtimeType: string;
        startCommand: string[];
    }): void {
        const now = Date.now();
        stmtInsert.run({
            projectId: record.projectId,
            createdAt: now,
            lastSeen: now,
            status: record.status,
            hostPort: record.hostPort,
            containerPort: record.containerPort,
            containerIp: record.containerIp,
            runtimeType: record.runtimeType,
            startCommand: JSON.stringify(record.startCommand),
        });
    }

    /** Update just the status field. */
    static setStatus(projectId: string, status: ProjectStatus): void {
        stmtUpdateStatus.run({ projectId, status });
    }

    /** Bulk-update status, ip, and lastSeen at once. */
    static updateRuntime(projectId: string, status: ProjectStatus, containerIp: string): void {
        stmtUpdateRuntime.run({ projectId, status, containerIp, lastSeen: Date.now() });
    }

    /** Refresh the lastSeen timestamp (called on every preview access). */
    static touch(projectId: string): void {
        stmtUpdateLastSeen.run({ projectId, lastSeen: Date.now() });
    }

    /** Fetch a single project by its ID. Returns null if not found. */
    static get(projectId: string): ProjectRecord | null {
        return (stmtGetById.get(projectId) as ProjectRecord | undefined) ?? null;
    }

    /** List all projects. */
    static getAll(): ProjectRecord[] {
        return stmtGetAll.all() as ProjectRecord[];
    }

    /** List projects filtered by status. */
    static getByStatus(status: ProjectStatus): ProjectRecord[] {
        return stmtGetByStatus.all(status) as ProjectRecord[];
    }

    /** Return all host ports that are currently in use (not stopped). */
    static getUsedHostPorts(): Set<number> {
        const rows = stmtGetUsedPorts.all() as { hostPort: number }[];
        return new Set(rows.map(r => r.hostPort));
    }

    /** Get projectIds that haven't been accessed since `beforeMs`. */
    static getInactiveIds(beforeMs: number): string[] {
        const rows = stmtGetInactive.all(beforeMs) as { projectId: string }[];
        return rows.map(r => r.projectId);
    }

    /** Delete a project record entirely. */
    static remove(projectId: string): void {
        stmtDelete.run(projectId);
    }

    /** Gracefully close the DB (called on process exit). */
    static close(): void {
        db.close();
    }
}

// ─── Graceful shutdown ───────────────────────────────────────────────────────
process.on('exit', () => ProjectDB.close());
process.on('SIGINT', () => { ProjectDB.close(); process.exit(0); });
process.on('SIGTERM', () => { ProjectDB.close(); process.exit(0); });
