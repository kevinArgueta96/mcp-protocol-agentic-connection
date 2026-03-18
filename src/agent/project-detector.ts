// Auto-detect project type from filesystem
// TODO: implement full detection logic

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type ProjectType = "node" | "rust" | "go" | "python" | "java" | "unknown";

export interface ProjectInfo {
  type: ProjectType;
  name: string;
  rootDir: string;
  configFile?: string;
  version?: string;
}

interface PackageJson {
  name?: string;
  version?: string;
}

const DETECTORS: Array<{
  file: string;
  type: ProjectType;
  parseName?: (content: string) => string | undefined;
}> = [
  {
    file: "package.json",
    type: "node",
    parseName: (content) => {
      try {
        return (JSON.parse(content) as PackageJson).name;
      } catch {
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

export async function detectProjectType(dir: string): Promise<ProjectInfo> {
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
    } catch {
      // File not found, try next
    }
  }

  return {
    type: "unknown",
    name: dir.split("/").pop() ?? "unknown",
    rootDir: dir,
  };
}
