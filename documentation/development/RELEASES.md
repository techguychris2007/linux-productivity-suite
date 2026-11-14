# Ubuntu release process

The CI workflow builds the Debian package and AppImage on Ubuntu 24.04. Branch pushes and pull requests keep the packages as 14-day workflow artifacts. A version tag runs the same checks and package build, then prepares a **draft** GitHub release with the `.deb`, AppImage, and `SHA256SUMS` attached. A maintainer reviews the draft before publishing it.

## Cut a release

1. Set `version` in `apps/shell/src-tauri/tauri.conf.json` to the release version, for example `0.1.5`.
2. Commit and push that version change to `main`.
3. Create and push the matching tag, with a `v` prefix:

   ```bash
   git tag v0.1.5
   git push origin v0.1.5
   ```

4. Wait for the `CI` workflow to pass. It checks that the tag version matches the app version and creates a draft release with both Linux packages and checksums.
5. Review the generated notes and assets, then publish the draft from GitHub Releases.

Do not reuse a release tag. If a build fails, fix the source and use a new patch version and tag.

## Verify downloaded files

Download the package and `SHA256SUMS` from the same release, then verify the checksum from that download directory:

```bash
sha256sum -c SHA256SUMS
```

Install the Debian package with:

```bash
sudo apt install ./Atlas_<version>_amd64.deb
```

The AppImage is portable but still requires compatible system WebKitGTK and Python 3.12 or newer. The release workflow does not sign packages, and a successful package build does not replace an install check on each supported Ubuntu release.
