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
  category?: "frontend" | "backend" | "fullstack";
  framework?: string;
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// FRONTEND frameworks (vue, react, angular only)
const FRONTEND_FRAMEWORKS: Record<string, string> = {
  "vue": "vue",
  "react": "react",
  "@angular/core": "angular",
};

// BACKEND frameworks
const BACKEND_FRAMEWORKS: Record<string, string> = {
  "express": "express",
  "fastify": "fastify",
  "@nestjs/core": "nestjs",
  "hono": "hono",
  "koa": "koa",
};

// FULLSTACK frameworks
const FULLSTACK_FRAMEWORKS: Record<string, string> = {
  "next": "next",
  "nuxt": "nuxt",
};

function detectNodeFramework(pkg: PackageJson): { category?: ProjectInfo["category"]; framework?: string } {
  const allDeps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };

  let detectedFrontend: string | undefined;
  let detectedBackend: string | undefined;

  for (const [dep, framework] of Object.entries(FULLSTACK_FRAMEWORKS)) {
    if (dep in allDeps) {
      return { category: "fullstack", framework };
    }
  }

  for (const [dep, framework] of Object.entries(FRONTEND_FRAMEWORKS)) {
    if (dep in allDeps) {
      detectedFrontend = framework;
      break;
    }
  }

  for (const [dep, framework] of Object.entries(BACKEND_FRAMEWORKS)) {
    if (dep in allDeps) {
      detectedBackend = framework;
      break;
    }
  }

  if (detectedFrontend && detectedBackend) {
    return { category: "fullstack", framework: detectedFrontend };
  }
  if (detectedFrontend) {
    return { category: "frontend", framework: detectedFrontend };
  }
  if (detectedBackend) {
    return { category: "backend", framework: detectedBackend };
  }

  return {};
}

function detectPythonFramework(content: string): { framework?: string; category?: "backend" } {
  const PYTHON_FRAMEWORKS: Record<string, string> = {
    "fastapi": "fastapi",
    "django": "django",
    "flask": "flask",
  };

  const lines = content.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Extract package name: take everything before ==, >=, ~=, !=, [, or space
    const pkgName = line.split(/[=><~!\[\s]/)[0].replace(/^['"]/, '').toLowerCase().trim();
    if (pkgName in PYTHON_FRAMEWORKS) {
      return { framework: PYTHON_FRAMEWORKS[pkgName], category: "backend" };
    }
  }
  return {};
}

function detectJavaFramework(content: string): { category?: ProjectInfo["category"]; framework?: string } {
  if (content.includes("spring-boot") || content.includes("spring-web")) {
    return { category: "backend", framework: "spring" };
  }
  return {};
}

const DETECTORS: Array<{
  file: string;
  type: ProjectType;
  parseName?: (content: string) => string | undefined;
  parseExtra?: (content: string) => { category?: ProjectInfo["category"]; framework?: string };
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
    parseExtra: (content) => {
      try {
        const pkg = JSON.parse(content) as PackageJson;
        return detectNodeFramework(pkg);
      } catch {
        return {};
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
    parseExtra: (content) => detectPythonFramework(content),
  },
  {
    file: "requirements.txt",
    type: "python",
    parseName: () => undefined,
    parseExtra: (content) => detectPythonFramework(content),
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
    parseExtra: (content) => detectJavaFramework(content),
  },
  {
    file: "build.gradle",
    type: "java",
    parseName: () => undefined,
    parseExtra: (content) => detectJavaFramework(content),
  },
];

export async function detectProjectType(dir: string): Promise<ProjectInfo> {
  for (const detector of DETECTORS) {
    const filePath = join(dir, detector.file);
    try {
      const content = await readFile(filePath, "utf-8");
      const name = detector.parseName?.(content) ?? dir.split("/").pop() ?? "unknown";
      const extra = detector.parseExtra?.(content) ?? {};
      const result: ProjectInfo = {
        type: detector.type,
        name,
        rootDir: dir,
        configFile: detector.file,
        ...extra,
      };

      // For Python projects, if no framework detected yet, try requirements.txt as fallback
      if (result.type === "python" && !result.framework && detector.file !== "requirements.txt") {
        try {
          const reqContent = await readFile(join(dir, "requirements.txt"), "utf-8");
          const pyExtra = detectPythonFramework(reqContent);
          Object.assign(result, pyExtra);
        } catch {
          // requirements.txt not found, that's fine
        }
      }

      return result;
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