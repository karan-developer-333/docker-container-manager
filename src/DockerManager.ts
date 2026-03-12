import Docker from 'dockerode';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs-extra';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export interface ContainerConfig {
    id: string;
    image: string;
    memory: number; // in bytes
    cpu: number;    // e.g., 0.5
    hostPort: number;       // unique port on the host (e.g. 3101)
    containerPort?: number; // port inside the container (default: 3000)
    env?: Record<string, string>;
}

export class DockerManager {
    private activeContainers: Map<string, Docker.Container> = new Map();

    async createContainer(config: ContainerConfig): Promise<Docker.Container> {
        const docker = new Docker({ socketPath: '/var/run/docker.sock' });

        // Pull image if not exists locally
        try {
            await docker.pull(config.image);
        } catch {
            // Image might already exist locally
        }

        const containerPort = (config.containerPort ?? 3000).toString();
        const portKey = `${containerPort}/tcp`;

        const container = await docker.createContainer({
            Image: config.image,
            name: `coder-project-${config.id}`,
            ExposedPorts: {
                [portKey]: {},
            },
            HostConfig: {
                Memory: config.memory,
                NanoCpus: config.cpu * 1e9,
                AutoRemove: true,
                PortBindings: {
                    [portKey]: [{ HostPort: config.hostPort.toString() }],
                },
            },
            Env: [
                ...Object.entries(config.env || {}).map(([k, v]) => `${k}=${v}`),
                // Tell vite/next/uvicorn to listen on ALL interfaces so Docker NAT can reach it
                `HOST=0.0.0.0`,
                `PORT=${containerPort}`,
            ],
            Tty: true,
        });

        this.activeContainers.set(config.id, container);
        return container;
    }

    async startContainer(id: string): Promise<void> {
        const container = this.activeContainers.get(id);
        if (!container) throw new Error(`Container ${id} not found`);
        await container.start();
    }

    async stopContainer(id: string): Promise<void> {
        const container = this.activeContainers.get(id);
        if (container) {
            await container.stop().catch(() => { }); // Ignore if already stopped
            this.activeContainers.delete(id);
        }
    }

    async execCommand(id: string, cmd: string[], onLog?: (data: string) => void): Promise<number> {
        const container = this.activeContainers.get(id);
        if (!container) throw new Error(`Container ${id} not found`);

        // Set PATH so node_modules/.bin, bun etc. are always found
        const fullCmd = `export PATH="/app/node_modules/.bin:/root/.bun/bin:$PATH" && cd /app && ${cmd.join(' ')}`;
        const exec = await container.exec({
            Cmd: ['sh', '-c', fullCmd],
            AttachStdout: true,
            AttachStderr: true,
        });

        const stream = await exec.start({ hijack: true, stdin: false });

        return new Promise((resolve, reject) => {
            // Use on('data') instead of demuxStream to avoid backpressure deadlock
            stream.on('data', (chunk: Buffer) => {
                // Docker multiplexed stream: first 8 bytes are header
                // byte 0: stream type (1=stdout, 2=stderr)
                // bytes 4-7: payload length (big-endian uint32)
                let offset = 0;
                while (offset < chunk.length) {
                    if (chunk.length < offset + 8) break;
                    const payloadLen = chunk.readUInt32BE(offset + 4);
                    const payload = chunk.slice(offset + 8, offset + 8 + payloadLen);
                    if (payload.length > 0) {
                        onLog?.(payload.toString());
                    }
                    offset += 8 + payloadLen;
                }
            });

            stream.on('end', async () => {
                try {
                    const result = await exec.inspect();
                    resolve(result.ExitCode ?? 0);
                } catch {
                    resolve(0);
                }
            });

            stream.on('error', reject);
        });
    }

    async execCommandBackground(id: string, cmd: string[], onLog?: (data: string) => void): Promise<void> {
        const container = this.activeContainers.get(id);
        if (!container) throw new Error(`Container ${id} not found`);

        // Include node_modules/.bin and bun in PATH so binaries like `next`, `vite` are found
        const cmdStr = cmd.join(' ');
        const fullCmd = `export PATH="/app/node_modules/.bin:/root/.bun/bin:$PATH" && ${cmdStr} >> /tmp/server.log 2>&1`;
        console.log("Command =>", cmdStr);
        const exec = await container.exec({
            Cmd: ['sh', '-c', `ls && npm i && ${fullCmd}`],
            AttachStdout: true,
            AttachStderr: true,
        });

        const stream = await exec.start({
            hijack: true,
            stdin: false,
        });

        stream.on("data", (chunk) => {
            console.log(chunk.toString());
        });
        onLog?.(`Started: ${cmdStr}`);
    }

    async waitForInstall(id: string, timeout: number = 300000): Promise<boolean> {
        const container = this.activeContainers.get(id);
        if (!container) throw new Error(`Container ${id} not found`);

        const startTime = Date.now();
        let lastLog = '';

        while (Date.now() - startTime < timeout) {
            try {
                // Check if node_modules exists (successful install indicator)
                const exec = await container.exec({
                    Cmd: ['sh', '-c', 'test -d /app/node_modules && echo "INSTALLED" || echo "NOT_INSTALLED"'],
                    AttachStdout: true,
                    AttachStderr: true,
                });

                const stream = await exec.start({});
                let output = '';

                await new Promise<void>((resolve) => {
                    docker.modem.demuxStream(stream, {
                        write: (chunk: Buffer) => { output += chunk.toString(); }
                    } as any, {
                        write: (chunk: Buffer) => { output += chunk.toString(); }
                    } as any);

                    stream.on('end', () => resolve());
                });

                if (output.includes('INSTALLED')) {
                    return true;
                }

                // Also check the install log for completion
                const logExec = await container.exec({
                    Cmd: ['sh', '-c', 'tail -5 /tmp/server.log 2>/dev/null || echo "No log yet"'],
                    AttachStdout: true,
                    AttachStderr: true,
                });

                const logStream = await logExec.start({});
                let logOutput = '';

                await new Promise<void>((resolve) => {
                    docker.modem.demuxStream(logStream, {
                        write: (chunk: Buffer) => { logOutput += chunk.toString(); }
                    } as any, {
                        write: (chunk: Buffer) => { logOutput += chunk.toString(); }
                    } as any);

                    logStream.on('end', () => resolve());
                });

                if (logOutput !== lastLog && logOutput.trim()) {
                    lastLog = logOutput;
                    console.log(`[${id}] Install log: ${logOutput.trim()}`);
                }

                // Check for common error patterns
                if (logOutput.includes('error') || logOutput.includes('Error') || logOutput.includes('ERR_')) {
                    return false;
                }

            } catch {
                // Keep waiting
            }

            await new Promise(r => setTimeout(r, 3000));
        }

        return false;
    }

    async waitForServer(id: string, port: number = 3000, timeout: number = 120000): Promise<boolean> {
        const container = this.activeContainers.get(id);
        if (!container) throw new Error(`Container ${id} not found`);

        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const exec = await container.exec({
                    Cmd: ['sh', '-c', `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} || echo "000"`],
                    AttachStdout: true,
                    AttachStderr: true,
                });

                const stream = await exec.start({ hijack: true, stdin: false });
                let output = '';

                await new Promise<void>((resolve, reject) => {
                    const timeoutId = setTimeout(() => {
                        stream.destroy();
                        resolve();
                    }, 5000);

                    stream.on('data', (chunk: Buffer) => {
                        let offset = 0;
                        while (offset < chunk.length) {
                            if (chunk.length < offset + 8) break;
                            const payloadLen = chunk.readUInt32BE(offset + 4);
                            const payload = chunk.slice(offset + 8, offset + 8 + payloadLen);
                            output += payload.toString();
                            offset += 8 + payloadLen;
                        }
                    });

                    stream.on('end', () => {
                        clearTimeout(timeoutId);
                        resolve();
                    });
                    stream.on('error', (err) => {
                        clearTimeout(timeoutId);
                        resolve(); // Resolve anyway to try again
                    });
                });

                const httpCode = parseInt(output.trim());
                if (!isNaN(httpCode) && httpCode >= 200 && httpCode < 500) {
                    return true;
                }
            } catch (err) {
                // Server not ready yet
            }

            await new Promise(r => setTimeout(r, 2000));
        }

        return false;
    }

    async tailLogs(id: string, filePath: string, onLog: (data: string) => void): Promise<void> {
        const container = this.activeContainers.get(id);
        if (!container) throw new Error(`Container ${id} not found`);

        const exec = await container.exec({
            Cmd: ['sh', '-c', `touch ${filePath} && tail -f ${filePath}`],
            AttachStdout: true,
            AttachStderr: true,
        });

        const stream = await exec.start({ hijack: true, stdin: false });

        stream.on('data', (chunk: Buffer) => {
            let offset = 0;
            while (offset < chunk.length) {
                if (chunk.length < offset + 8) break;
                const payloadLen = chunk.readUInt32BE(offset + 4);
                const payload = chunk.slice(offset + 8, offset + 8 + payloadLen);
                if (payload.length > 0) {
                    onLog(payload.toString());
                }
                offset += 8 + payloadLen;
            }
        });

        stream.on('error', (err) => {
            console.error(`[${id}] tailLogs error:`, err);
        });
    }

    async getContainerLogs(id: string): Promise<string> {
        const container = this.activeContainers.get(id);
        if (!container) throw new Error(`Container ${id} not found`);

        try {
            const logStream = await container.logs({
                stdout: true,
                stderr: true,
                tail: 100,
            });

            return logStream.toString();
        } catch {
            return '';
        }
    }

    async getContainerIp(id: string): Promise<string> {
        const container = this.activeContainers.get(id);
        if (!container) throw new Error(`Container ${id} not found`);
        const inspect = await container.inspect();
        // Fallback to Bridge network if available
        const networks = inspect.NetworkSettings.Networks;
        const netName = Object.keys(networks)[0];
        return networks[netName]?.IPAddress || '';
    }

    async copyToContainer(id: string, sourcePath: string, destPath: string): Promise<void> {
        const container = this.activeContainers.get(id);
        if (!container) throw new Error(`Container ${id} not found`);

        const archiver = require('archiver');
        const tarStream = archiver('tar');

        tarStream.directory(sourcePath, false);
        tarStream.finalize();

        await container.putArchive(tarStream, { path: destPath });
    }

    async buildWorkerImage(dockerfilePath: string, imageTag: string): Promise<void> {
        console.log(`Building worker image: ${imageTag}...`);
        const tar = require('tar-fs');
        const stream = tar.pack(path.dirname(dockerfilePath));

        return new Promise((resolve, reject) => {
            docker.buildImage(stream, { t: imageTag, dockerfile: path.basename(dockerfilePath) }, (err, response) => {
                if (err) return reject(err);
                if (!response) return reject(new Error('No response from docker build'));

                docker.modem.followProgress(response, (err, res) => {
                    if (err) return reject(err);
                    console.log(`${imageTag} image built successfully`);
                    resolve();
                }, (event) => {
                    if (event.stream) process.stdout.write(event.stream);
                });
            });
        });
    }

    async isProcessRunning(id: string, searchPattern: string): Promise<boolean> {
        const container = this.activeContainers.get(id);
        if (!container) return false;

        try {
            const exec = await container.exec({
                Cmd: ['sh', '-c', `ps aux | grep "${searchPattern}" | grep -v grep`],
                AttachStdout: true,
                AttachStderr: true,
            });

            const stream = await exec.start({ hijack: true, stdin: false });
            let output = '';

            await new Promise<void>((resolve) => {
                stream.on('data', (chunk: Buffer) => {
                    let offset = 0;
                    while (offset < chunk.length) {
                        if (chunk.length < offset + 8) break;
                        const payloadLen = chunk.readUInt32BE(offset + 4);
                        const payload = chunk.slice(offset + 8, offset + 8 + payloadLen);
                        output += payload.toString();
                        offset += 8 + payloadLen;
                    }
                });
                stream.on('end', () => resolve());
                stream.on('error', () => resolve());
            });

            return output.trim().length > 0;
        } catch {
            return false;
        }
    }
}
