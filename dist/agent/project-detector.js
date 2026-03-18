// Auto-detect project type from filesystem
// TODO: implement full detection logic
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const DETECTORS = [
    {
        file: "package.json",
        type: "node",
        parseName: (content) => {
            try {
                return JSON.parse(content).name;
            }
            catch {
                return undefined;
            }
        },
    },
    {
        file: "Cargo.toml",
        type: "rust",
        parseName: (content) => content.match(/^name\s*=\s*"([^"]+)"/m)?.[1],
    },
    {
        file: "go.mod",
        type: "go",
        parseName: (content) => content.match(/^module\s+(\S+)/m)?.[1]?.split("/").pop(),
    },
    {
        file: "pyproject.toml",
        type: "python",
        parseName: (content) => content.match(/^name\s*=\s*"([^"]+)"/m)?.[1],
    },
    {
        file: "setup.py",
        type: "python",
        parseName: () => undefined,
    },
    {
        file: "pom.xml",
        type: "java",
        parseName: (content) => content.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1],
    },
    {
        file: "build.gradle",
        type: "java",
        parseName: () => undefined,
    },
];
export async function detectProjectType(dir) {
    for (const detector of DETECTORS) {
        const filePath = join(dir, detector.file);
        try {
            const content = await readFile(filePath, "utf-8");
            const name = detector.parseName?.(content) ?? dir.split("/").pop() ?? "unknown";
            return {
                type: detector.type,
                name,
                rootDir: dir,
                configFile: detector.file,
            };
        }
        catch {
            // File not found, try next
        }
    }
    return {
        type: "unknown",
        name: dir.split("/").pop() ?? "unknown",
        rootDir: dir,
    };
}
//# sourceMappingURL=project-detector.js.map