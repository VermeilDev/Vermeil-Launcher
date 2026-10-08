// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

export interface CrashDiagnostic {
  category: string;
  categoryClass: "diag-danger" | "diag-warn" | "diag-info" | "diag-accent";
  iconName: "alert" | "memory" | "java" | "mod" | "conflict" | "gpu" | "file";
  title: string;
  description: string;
  rootCauseSnippet: string;
  actionLabel?: string;
  actionType: "memory" | "java" | "mods" | "none";
  rootCauseLineIndex: number;
}

function javaVersionFromClassVersion(verStr: string): string {
  const v = parseFloat(verStr);
  if (v >= 69) return "Java 25";
  if (v >= 66) return "Java 22";
  if (v >= 65) return "Java 21";
  if (v >= 61) return "Java 17";
  if (v >= 60) return "Java 16";
  if (v >= 55) return "Java 11";
  if (v >= 52) return "Java 8";
  return `Java (class ${verStr})`;
}

/**
 * Analyzes Minecraft crash report text or recent game console logs completely offline
 * with zero network calls and extracts a structured, human-readable diagnosis.
 */
export function analyzeCrashReport(text: string): CrashDiagnostic {
  const lines = text.split("\n");
  const normalized = text.toLowerCase();

  // 1. Search for root cause line index:
  // In Java stack traces, the true culprit is almost always in the last "Caused by:" clause.
  let rootCauseLineIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith("Caused by:") || l.includes("Caused by: java.") || l.includes("Caused by: net.")) {
      rootCauseLineIndex = i;
      break;
    }
  }

  // Fallback: look for lines containing key exceptions from top
  if (rootCauseLineIndex === -1) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (
        /OutOfMemoryError|UnsupportedClassVersionError|FormattedException|MixinTransformerError|InjectionError|DuplicateMods|GLFW error|Could not find or load main class/i.test(l)
      ) {
        rootCauseLineIndex = i;
        break;
      }
    }
  }

  if (rootCauseLineIndex === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (/Exception in thread|Description:|\bException\b|\bError\b/i.test(lines[i])) {
        rootCauseLineIndex = i;
        break;
      }
    }
  }

  if (rootCauseLineIndex === -1) {
    rootCauseLineIndex = 0;
  }

  const rawRootLine = lines[rootCauseLineIndex]?.trim() || "Unknown error";
  const rootCauseSnippet = rawRootLine.replace(/^Caused by:\s*/, "");

  // 2. Archetype Matching:
  // A. Out of Memory / Java Heap Exhaustion
  if (
    normalized.includes("outofmemoryerror") ||
    normalized.includes("java heap space") ||
    normalized.includes("gc overhead limit exceeded") ||
    normalized.includes("could not reserve enough space for")
  ) {
    return {
      category: "RAM EXHAUSTION",
      categoryClass: "diag-danger",
      iconName: "memory",
      title: "Out of Memory (Java Heap Exhaustion)",
      description:
        "Minecraft ran out of allocated memory during startup or gameplay. Modpacks typically require at least 4 GB to 6 GB of RAM.",
      rootCauseSnippet: rootCauseSnippet || "java.lang.OutOfMemoryError: Java heap space",
      actionLabel: "Adjust Instance Memory",
      actionType: "memory",
      rootCauseLineIndex,
    };
  }

  // B. Java Version Incompatibility
  if (
    normalized.includes("unsupportedclassversionerror") ||
    normalized.includes("has been compiled by a more recent version of the java runtime")
  ) {
    const classVerMatch = text.match(/class file version\s*(\d+(?:\.\d+)?)/i);
    const requiredJava = classVerMatch ? javaVersionFromClassVersion(classVerMatch[1]) : "a newer Java runtime";

    return {
      category: "JAVA MISMATCH",
      categoryClass: "diag-warn",
      iconName: "java",
      title: "Java Version Incompatible",
      description: `A mod or game library requires ${requiredJava}, but the instance is running an older Java version.`,
      rootCauseSnippet: rootCauseSnippet || `UnsupportedClassVersionError: requires ${requiredJava}`,
      actionLabel: "Open Java Settings",
      actionType: "java",
      rootCauseLineIndex,
    };
  }

  // C. Missing Mod Dependency
  if (
    normalized.includes("unmet dependencies") ||
    normalized.includes("requires mod") ||
    normalized.includes("missing or unsupported mandatory dependencies") ||
    normalized.includes("modresolutionexception")
  ) {
    // Attempt to parse required mod name
    let depDetail = "";
    const reqMatch = text.match(/requires mod ['"]?([a-zA-Z0-9_-]+)['"]?/i) ||
                     text.match(/requires ['"]?([a-zA-Z0-9_-]+)['"]?/i);
    if (reqMatch) {
      depDetail = ` Mod '${reqMatch[1]}' is missing or outdated.`;
    }

    return {
      category: "MISSING DEPENDENCY",
      categoryClass: "diag-info",
      iconName: "mod",
      title: "Unmet Mod Dependency",
      description: `One of your installed mods requires an additional dependency that was not found.${depDetail}`,
      rootCauseSnippet: rootCauseSnippet || "ModResolutionException: Unmet mod dependencies",
      actionLabel: "Manage Installed Mods",
      actionType: "mods",
      rootCauseLineIndex,
    };
  }

  // D. Mod Conflict / Mixin Collision
  if (
    normalized.includes("mixintransformererror") ||
    normalized.includes("duplicatemods") ||
    normalized.includes("duplicate mod id") ||
    normalized.includes("injectionerror") ||
    normalized.includes("mixin apply failed") ||
    normalized.includes("collided with")
  ) {
    return {
      category: "MOD CONFLICT",
      categoryClass: "diag-warn",
      iconName: "conflict",
      title: "Mod Incompatibility / Mixin Conflict",
      description:
        "Two or more installed mods attempted to modify the same internal Minecraft code hook or have conflicting mod IDs.",
      rootCauseSnippet: rootCauseSnippet || "MixinTransformerError: Collision detected in class injection",
      actionLabel: "Manage Installed Mods",
      actionType: "mods",
      rootCauseLineIndex,
    };
  }

  // E. Graphics Driver / OpenGL
  if (
    normalized.includes("glfw error 65542") ||
    normalized.includes("pixel format not accelerated") ||
    normalized.includes("wgl: the driver does not appear to support opengl") ||
    normalized.includes("could not init gl")
  ) {
    return {
      category: "GPU / OPENGL ERROR",
      categoryClass: "diag-warn",
      iconName: "gpu",
      title: "Graphics Driver / OpenGL Failure",
      description:
        "Minecraft could not initialize OpenGL graphics. This usually indicates outdated GPU drivers or an incompatible shaderpack.",
      rootCauseSnippet: rootCauseSnippet || "GLFW error 65542: WGL Pixel format not accelerated",
      actionType: "none",
      rootCauseLineIndex,
    };
  }

  // F. Corrupted Main Class / Engine Failure
  if (
    normalized.includes("could not find or load main class net.minecraft.client.main.main") ||
    normalized.includes("classnotfoundexception: net.minecraft.client.main.main")
  ) {
    return {
      category: "LAUNCH CORRUPTION",
      categoryClass: "diag-danger",
      iconName: "file",
      title: "Client Launch Class Missing",
      description: "Minecraft's main execution class could not be loaded. Libraries may be incomplete or corrupted.",
      rootCauseSnippet: rootCauseSnippet || "ClassNotFoundException: net.minecraft.client.main.Main",
      actionType: "none",
      rootCauseLineIndex,
    };
  }

  // G. General Fallback
  return {
    category: "UNHANDLED CRASH",
    categoryClass: "diag-danger",
    iconName: "alert",
    title: "Unhandled Minecraft Exception",
    description: "An unexpected exception interrupted the Minecraft game loop. See the identified root cause line below.",
    rootCauseSnippet: rootCauseSnippet || "Unexpected crash without recognized signature",
    actionType: "none",
    rootCauseLineIndex,
  };
}
