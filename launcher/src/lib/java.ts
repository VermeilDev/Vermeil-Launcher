// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Shared Java runtime and distribution helpers.
 * One source of truth for vendor detection, display naming, and action labels.
 */

export type JavaVendor = "adoptium" | "zulu" | "corretto" | "microsoft" | "oracle" | "unknown";

/** Detect the vendor of a Java runtime path or version string. */
export function detectJavaVendor(path?: string, fullVersion?: string): JavaVendor {
  if (!path) return "unknown";
  const s = `${path} ${fullVersion || ""}`.toLowerCase();
  if (s.includes("corretto") || s.includes("amazon")) return "corretto";
  if (s.includes("zulu") || s.includes("azul")) return "zulu";
  if (s.includes("adoptium") || s.includes("temurin") || s.includes("eclipse")) return "adoptium";
  if (s.includes("microsoft")) return "microsoft";
  if (s.includes("oracle")) return "oracle";
  if (s.includes("vermeil\\java\\jdk-") || s.includes("vermeil/java/jdk-")) return "adoptium";
  return "unknown";
}

/** Short distribution label (e.g. "Zulu", "Corretto", "Adoptium"). */
export function javaVendorShortName(vendor: string): string {
  switch (vendor.toLowerCase()) {
    case "zulu": return "Zulu";
    case "corretto": return "Corretto";
    case "microsoft": return "Microsoft";
    case "oracle": return "Oracle";
    default: return "Adoptium";
  }
}

/** Full official distribution label (e.g. "Azul Zulu", "Amazon Corretto", "Eclipse Adoptium (Temurin)"). */
export function javaVendorFullName(vendor: string): string {
  switch (vendor.toLowerCase()) {
    case "zulu": return "Azul Zulu";
    case "corretto": return "Amazon Corretto";
    case "microsoft": return "Microsoft Build of OpenJDK";
    case "oracle": return "Oracle JDK";
    default: return "Adoptium (Temurin)";
  }
}

/** Official owner / organization that publishes the distribution (e.g. "Amazon", "Azul Systems", "Eclipse Foundation"). */
export function javaVendorOwner(vendor: string): string {
  const v = (vendor || "").toLowerCase();
  if (v.includes("corretto") || v.includes("amazon")) return "Amazon";
  if (v.includes("zulu") || v.includes("azul")) return "Azul Systems";
  if (v.includes("adoptium") || v.includes("temurin") || v.includes("eclipse")) return "Eclipse Foundation";
  if (v.includes("microsoft")) return "Microsoft";
  if (v.includes("oracle")) return "Oracle";
  return "Eclipse Foundation";
}

/** Button label for the install/switch/reinstall action button. */
export function javaActionButtonLabel(
  installed: boolean,
  currentPath: string,
  fullVersion: string | undefined,
  targetDistro: string,
  isBusy: boolean | string | null
): string {
  if (isBusy === "queued") return "Queued...";
  if (isBusy === true || isBusy === "install") return "Installing...";
  const targetShort = javaVendorShortName(targetDistro);
  if (!installed) return `Install ${targetShort}`;
  const currVendor = detectJavaVendor(currentPath, fullVersion);
  if (currVendor === targetDistro) return "Reinstall";
  return `Switch to ${targetShort}`;
}

/** Tooltip text for the install/switch/reinstall action button. */
export function javaActionButtonTip(
  installed: boolean,
  currentPath: string,
  fullVersion: string | undefined,
  targetDistro: string,
  major: number,
  isManaged?: boolean
): string {
  const targetShort = javaVendorShortName(targetDistro);
  if (!installed) {
    return `Install ${targetShort} for Java ${major}`;
  }
  if (isManaged === false) {
    return `Install isolated ${targetShort} build`;
  }
  const currVendor = detectJavaVendor(currentPath, fullVersion);
  if (currVendor === targetDistro) {
    return `Reinstall ${targetShort}`;
  }
  return `Switch to ${targetShort}`;
}
