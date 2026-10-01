# Terms of Service

Last updated: September 23, 2026

These Terms of Service ("Terms") govern your use of the Vermeil desktop application, companion mod, and website located at [https://vermeillauncher.app/](https://vermeillauncher.app/) (collectively, "Vermeil").

By installing, downloading, accessing, or using Vermeil, you agree to be bound by these Terms. If you do not agree to these Terms, please do not use the application or website.

---

## 1. Open Source License & Branding Terms

Vermeil source code is free, open-source software licensed under the **GNU General Public License v3.0 or later** ([GPL-3.0-or-later](LICENSE)). The complete source code is publicly accessible on GitHub at [https://github.com/VermeilDev/Vermeil-Launcher](https://github.com/VermeilDev/Vermeil-Launcher).

Subject to the conditions of the GPLv3, you are free to inspect, modify, fork, and compile the software, provided that any distributed derivative works remain open-source under GPLv3.

Pursuant to Section 7 of the GPLv3, all logos, application icons, 3D theme emblems, and the name "Vermeil" are **All Rights Reserved**; forks and third-party distributions must rebrand and replace all official visual assets. See [LICENSES.md](LICENSES.md) for complete details.

---

## 2. Unofficial Project & Minecraft Notice

Vermeil is an independent, open-source launcher and is **NOT** an official Minecraft product. It is **NOT** approved by, endorsed by, or associated with Mojang Studios or Microsoft.

- "Minecraft" is a registered trademark of Mojang Studios.
- To use online Microsoft authentication and play Minecraft: Java Edition, you must possess a legitimate, paid Minecraft license tied to a valid Microsoft account.
- Vermeil does not circumvent, crack, or disable Minecraft DRM or multiplayer authentication.

---

## 3. Acceptable Use

You agree to use Vermeil in compliance with all applicable laws and regulations. You agree not to:

- Use Vermeil to distribute malicious software, trojans, ransomware, or spyware.
- Use Vermeil to violate the intellectual property, privacy, or legal rights of other individuals or creators.
- Overload, attack, or abuse third-party APIs connected to the launcher (such as Mojang, Modrinth, CurseForge, Adoptium, or Google APIs).

---

## 4. Third-Party Integrations

Vermeil acts as a client connecting to various third-party services on your behalf. Your use of these third-party services is subject to their respective terms and privacy policies:

- **Microsoft / Xbox Live:** For authenticating your Minecraft license via OAuth 2.0 PKCE.
- **Modrinth & CurseForge:** For searching and downloading mods, resource packs, shaders, and modpacks.
- **Adoptium (Eclipse Foundation):** For downloading official open-source Java runtimes (Temurin JDK).
- **Crafty.gg:** For on-demand historical skin synchronization in the Wardrobe.
- **Google Drive API:** For optional launcher settings cloud synchronization.
- **Vermeil Share Code Relay (`share.vermeillauncher.workers.dev`):** For optional 3-minute ephemeral sharing and resolving of instance blueprint manifests.

---

## 5. Google Drive Cloud Settings Sync & Limited Use

Vermeil offers an optional cloud backup feature for launcher preferences using Google Drive:

- **Sandboxed Directory:** Vermeil requests access only to the Google Drive Application Data folder (`https://www.googleapis.com/auth/drive.appdata`). This is an isolated, private sandbox.
- **No Personal File Access:** Vermeil has zero access to your personal files, spreadsheets, photos, or documents stored in Google Drive.
- **Hardware Settings Excluded:** Machine-specific parameters (such as JVM RAM allocation, window dimensions, and Java paths) are strictly filtered out and kept on local disk to prevent cross-device conflicts.
- **User Revocation:** You may sign out locally or completely revoke authorization on Google's servers at any time via Vermeil Settings or through your [Google Account Security Settings](https://myaccount.google.com/permissions).
- **Google API Services User Data Policy Compliance:** Vermeil adheres strictly to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Your data is never sold, shared, used for advertising, or used to train machine learning models.

---

## 6. Disclaimer of Warranties

TO THE MAXIMUM EXTENT PERMITTED BY LAW, VERMEIL IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.

THE AUTHORS DO NOT WARRANT THAT THE APPLICATION WILL BE ERROR-FREE, SECURE, OR UNINTERRUPTED, OR COMPATIBLE WITH ALL HARDWARE, OPERATING SYSTEMS, OR COMMUNITY MODS.

---

## 7. Limitation of Liability

IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE (INCLUDING LOSS OF DATA, SAVE CORRUPTION, OR SYSTEM UNSTABILITY).

---

## 8. Changes & Contact

We reserve the right to modify these Terms as the application evolves. Updates will be reflected in this file and on [https://vermeillauncher.app/terms.html](https://vermeillauncher.app/terms.html).

For security reports or inquiries, please contact us via [GitHub Security Advisories](https://github.com/VermeilDev/Vermeil-Launcher/security) or open an issue on GitHub.
