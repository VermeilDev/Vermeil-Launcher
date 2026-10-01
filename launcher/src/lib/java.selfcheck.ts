// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

/* Runnable self-check for Java helpers. Run with:
 *   npx tsx src/lib/java.selfcheck.ts
 */
import {
  detectJavaVendor,
  javaActionButtonLabel,
  javaActionButtonTip,
} from "./java";

function assertEq<T>(actual: T, expected: T, desc: string) {
  if (actual !== expected) {
    throw new Error(`FAIL [${desc}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// 1. Vendor detection
assertEq(
  detectJavaVendor(String.raw`C:\Users\User\AppData\Local\Vermeil\java\amazon\jdk-25\bin\java.exe`),
  "corretto",
  "amazon path should detect corretto"
);
assertEq(
  detectJavaVendor(String.raw`C:\Users\User\AppData\Local\Vermeil\java\zulu\jdk-25\bin\java.exe`),
  "zulu",
  "zulu path should detect zulu"
);
assertEq(
  detectJavaVendor(String.raw`C:\Program Files\Eclipse Adoptium\jdk-8.0.492.9-hotspot\bin\javaw.exe`),
  "adoptium",
  "adoptium path should detect adoptium"
);
assertEq(
  detectJavaVendor(String.raw`C:\Users\User\AppData\Local\Vermeil\java\jdk-21\jdk-21.0.12.1+1-jre\bin\java.exe`),
  "adoptium",
  "legacy vermeil path should detect adoptium"
);

// 2. Action button labels
// Slot with Amazon Corretto installed, user chose Azul Zulu
assertEq(
  javaActionButtonLabel(
    true,
    String.raw`C:\Users\User\AppData\Local\Vermeil\java\amazon\jdk-25\bin\java.exe`,
    "25.0.4.1",
    "zulu",
    false
  ),
  "Switch to Zulu",
  "different vendor should show Switch to <Vendor>"
);

// Slot with Azul Zulu installed, user chose Azul Zulu
assertEq(
  javaActionButtonLabel(
    true,
    String.raw`C:\Users\User\AppData\Local\Vermeil\java\zulu\jdk-25\bin\java.exe`,
    "25.0.4.1",
    "zulu",
    false
  ),
  "Reinstall",
  "same vendor should show Reinstall"
);

// Missing slot, user chose Azul Zulu
assertEq(
  javaActionButtonLabel(false, "", undefined, "zulu", false),
  "Install Zulu",
  "missing slot should show Install <Vendor>"
);

// Busy installing
assertEq(
  javaActionButtonLabel(false, "", undefined, "zulu", true),
  "Installing...",
  "busy slot should show Installing..."
);

// Queued
assertEq(
  javaActionButtonLabel(false, "", undefined, "zulu", "queued"),
  "Queued...",
  "queued slot should show Queued..."
);

// 3. Tooltip text
assertEq(
  javaActionButtonTip(
    true,
    String.raw`C:\Users\User\AppData\Local\Vermeil\java\amazon\jdk-25\bin\java.exe`,
    "25.0.4.1",
    "zulu",
    25
  ),
  "Replace current Java with official Azul Zulu for Java 25",
  "switching tooltip should explain replacement"
);

assertEq(
  javaActionButtonTip(
    true,
    String.raw`C:\Users\User\AppData\Local\Vermeil\java\zulu\jdk-25\bin\java.exe`,
    "25.0.4.1",
    "zulu",
    25
  ),
  "Reinstall a fresh copy of Azul Zulu for Java 25",
  "reinstall tooltip should explain fresh copy"
);

assertEq(
  javaActionButtonTip(
    true,
    String.raw`C:\Program Files\Eclipse Adoptium\jdk-8.0.492.9-hotspot\bin\javaw.exe`,
    "1.8.0_492",
    "adoptium",
    8,
    false
  ),
  "Download official Adoptium (Temurin) into Vermeil AppData (your system installation will remain untouched)",
  "unmanaged external install tooltip should reassure user"
);

// 4. Vendor owner attribution
import { javaVendorOwner } from "./java";
assertEq(javaVendorOwner("corretto"), "Amazon", "corretto is owned by Amazon");
assertEq(javaVendorOwner("amazon"), "Amazon", "amazon resolves to Amazon");
assertEq(javaVendorOwner("zulu"), "Azul Systems", "zulu is owned by Azul Systems");
assertEq(javaVendorOwner("azul"), "Azul Systems", "azul resolves to Azul Systems");
assertEq(javaVendorOwner("adoptium"), "Eclipse Foundation", "adoptium is owned by Eclipse Foundation");
assertEq(javaVendorOwner("temurin"), "Eclipse Foundation", "temurin is owned by Eclipse Foundation");
assertEq(javaVendorOwner("microsoft"), "Microsoft", "microsoft is owned by Microsoft");
assertEq(javaVendorOwner("oracle"), "Oracle", "oracle is owned by Oracle");

console.log("java.selfcheck: all checks passed successfully");
