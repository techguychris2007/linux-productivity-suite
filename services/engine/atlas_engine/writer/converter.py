"""LibreOffice headless converter (free, already on most Ubuntu desktops: `sudo apt install libreoffice-writer`).

Runs `soffice --headless --convert-to` in a private profile directory, one conversion at a time
(LibreOffice cannot share a profile between concurrent processes), with a hard timeout.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path

FORMATS = {
    # target: (extension, export filter)
    "docx": ("docx", "docx:MS Word 2007 XML"),
    "odt": ("odt", "odt:writer8"),
    "pdf": ("pdf", "pdf:writer_pdf_Export"),
    "html": ("html", "html:HTML (StarWriter)"),
}
IMPORTABLE = {".docx", ".doc", ".odt", ".rtf", ".html", ".htm", ".txt"}


class ConversionError(Exception):
    pass


class LibreOffice:
    def __init__(self, profile_dir: Path, binary: str | None = None, timeout: float = 120.0) -> None:
        self.binary = binary or shutil.which("soffice") or shutil.which("libreoffice")
        self.profile_dir = profile_dir
        self.timeout = timeout
        self._lock = threading.Lock()

    def available(self) -> bool:
        return bool(self.binary)

    def convert_bytes(self, data: bytes, src_ext: str, target: str, html_input: bool = False) -> bytes:
        if not self.binary:
            raise ConversionError("LibreOffice is not installed. Install it with: sudo apt install libreoffice-writer")
        if target not in FORMATS:
            raise ConversionError(f"unsupported target format '{target}'")
        ext, filt = FORMATS[target]
        with self._lock, tempfile.TemporaryDirectory(prefix="atlas-convert-") as tmp:
            src = Path(tmp) / f"input{src_ext}"
            src.write_bytes(data)
            out_dir = Path(tmp) / "out"
            cmd = [self.binary, f"-env:UserInstallation={self.profile_dir.resolve().as_uri()}", "--headless", "--norestore",
                   "--nolockcheck"]
            if html_input:
                # Import HTML as a Writer document (not Writer/Web) so headings map to real Heading styles.
                cmd.append("--infilter=HTML (StarWriter)")
            cmd += ["--convert-to", filt, "--outdir", str(out_dir), str(src)]
            env = {**os.environ, "SAL_USE_VCLPLUGIN": "svp", "HOME": str(self.profile_dir)}
            try:
                proc = subprocess.run(cmd, capture_output=True, timeout=self.timeout, env=env)
            except subprocess.TimeoutExpired as e:
                raise ConversionError("LibreOffice took too long to convert the document") from e
            out = out_dir / f"input.{ext}"
            if not out.exists():
                raise ConversionError(f"conversion failed: {(proc.stderr or proc.stdout).decode(errors='replace')[-300:]}")
            return out.read_bytes()
