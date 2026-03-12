import path from 'path';

export type RuntimeType = 'node' | 'python' | 'static';

export interface RuntimeConfig {
    type: RuntimeType;
    installCommand: string[];
    startCommand: string[];
    image: string;
    packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' | 'pip';
}

export class RuntimeDetector {
    static detect(files: { path: string, content: string }[]): RuntimeConfig {
        const filenames = files.map(f => f.path);

        // Check for package manager hints
        const hasYarn = filenames.includes('yarn.lock');
        const hasPnpm = filenames.includes('pnpm-lock.yaml');
        const hasBun = filenames.includes('bun.lockb');
        const hasPackageLock = filenames.includes('package-lock.json');

        // Default to npm, only use other package managers if lock file exists
        let packageManager: 'npm' | 'yarn' | 'pnpm' | 'bun' = 'npm';
        if (hasYarn) packageManager = 'yarn';
        else if (hasPnpm) packageManager = 'pnpm';
        else if (hasBun) packageManager = 'bun';

        // 1. Node.js detection
        if (filenames.includes('package.json')) {
            const packageJsonFile = files.find(f => f.path === 'package.json');
            let startCommand = ['bun', 'run', 'start'];

            if (packageJsonFile) {
                try {
                    const pkg = JSON.parse(packageJsonFile.content);
                    // Always use bun to run scripts — it's pre-installed and fast in the worker image
                    if (pkg.scripts?.dev) {
                        startCommand = ['bun', 'run', 'dev'];
                    } else if (pkg.scripts?.start) {
                        startCommand = ['bun', 'run', 'start'];
                    }
                } catch (e) { }
            }

            // Always use bun for installation — it's pre-installed and much faster than npm in Docker
            const installCmd = ['bun', 'install'];

            return {
                type: 'node',
                installCommand: installCmd,
                startCommand: startCommand,
                image: 'coder-node',
                packageManager: 'bun', // Always bun in Docker
            };
        }

        // 2. Python detection
        if (filenames.includes('requirements.txt') || filenames.some(f => f.endsWith('.py'))) {
            let entryPoint = 'main.py';
            if (filenames.includes('app.py')) entryPoint = 'app.py';

            return {
                type: 'python',
                installCommand: filenames.includes('requirements.txt') ? [
                    'python3', '-m', 'venv', 'venv',
                    '&&', 'source', 'venv/bin/activate',
                    '&&', 'pip', 'install', '-r', 'requirements.txt'
                ] : [],
                startCommand: [
                    'source', 'venv/bin/activate',
                    '&&', 'python3', '-u', entryPoint
                ],
                image: 'coder-python',
                packageManager: 'pip' as const,
            };
        }

        // 3. C++ detection
        if (filenames.some(f => f.endsWith('.cpp') || f.endsWith('.c'))) {
            const cppFile = filenames.find(f => f.endsWith('.cpp') || f.endsWith('.c'))!;
            return {
                type: 'static',
                installCommand: ['g++', cppFile, '-o', 'app'],
                startCommand: ['./app'],
                image: 'coder-node',
                packageManager: 'npm' as const,
            };
        }

        // 4. Static detection (Fallback)
        return {
            type: 'static',
            installCommand: [],
            startCommand: ['npx', 'serve', '.', '-p', '8000'],
            image: 'coder-node',
            packageManager: 'npm',
        };
    }
}
