# VR_Project / Plugins

Unreal Engine plugins required by the project live here.

Plugins distributed as pre-built SDK binaries are **not** committed to the
repository (see [`.gitignore`](../../.gitignore)). Each developer and CI
runner installs them manually before opening the project.

## Required plugins

### Agora-Unreal-RTC-SDK — v4.5.0

Used for the bidirectional voice + custom video source pipeline between the
headset and the instructor browser.

- **Upstream:** <https://github.com/AgoraIO-Extensions/Agora-Unreal-RTC-SDK>
- **Pinned release:** <https://github.com/AgoraIO-Extensions/Agora-Unreal-RTC-SDK/releases/tag/v4.5.0>
- **Install instructions:** see the
  [root `README.md` → Setup → step 2](../../README.md#2-install-the-agora-ue-plugin-manual--required).
- **Final installed path:**

  ```
  VR_Project/Plugins/AgoraPlugin/
  ```

That folder is gitignored and will not appear in `git status` once correctly
placed.
