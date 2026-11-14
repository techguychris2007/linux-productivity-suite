"""Atlas Drive toolset. Every call goes through the Rust core, which enforces folder grants,
read-only access, path confinement and approvals."""

from __future__ import annotations

from ..core_client import CoreClient
from ..tools import ToolContext, ToolRegistry, ToolResult

_GRANT = {"type": "string", "minLength": 1, "description": "Folder grant id from drive.list_folders"}
_PATH = {"type": "string", "description": "Path relative to the granted folder, e.g. 'reports/q3.md'"}


def register(reg: ToolRegistry, core: CoreClient) -> None:
    def with_token(args: dict, ctx: ToolContext) -> dict:
        return {**args, "approval_token": ctx.approval_token} if ctx.approval_token else args

    @reg.tool("drive.list_folders", "List the folders the user has shared with Atlas AI.",
              {"type": "object", "properties": {}, "additionalProperties": False}, "read", "drive")
    def list_folders(args, ctx):
        gs = core.call("grants.list")
        return ToolResult([{"grant": g["id"], "label": g["label"], "access": g["access"]} for g in gs],
                          summary=f"{len(gs)} shared folder{'' if len(gs) == 1 else 's'}: " + ", ".join(g["label"] for g in gs) if gs else "No folders are shared with Atlas AI")

    @reg.tool("drive.list", "List files and folders inside a shared folder.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _PATH}, "required": ["grant"],
               "additionalProperties": False}, "read", "drive")
    def list_dir(args, ctx):
        entries = core.call("fs.list", **args)
        # File names are user/third-party controlled text.
        return ToolResult([{k: e[k] for k in ("name", "path", "kind", "size")} for e in entries],
                          untrusted=True, source=f"folder listing {args.get('path', '') or '/'}",
                          summary=f"{len(entries)} item{'' if len(entries) == 1 else 's'} in /{args.get('path', '')}")

    @reg.tool("drive.search", "Find files by name inside a shared folder.",
              {"type": "object", "properties": {"grant": _GRANT, "query": {"type": "string", "minLength": 1},
                                                "limit": {"type": "integer", "minimum": 1, "maximum": 200}},
               "required": ["grant", "query"], "additionalProperties": False}, "read", "drive")
    def search(args, ctx):
        res = core.call("fs.search", **args)
        return ToolResult([{k: e[k] for k in ("name", "path", "kind")} for e in res], untrusted=True, source="file search",
                          summary=f"Found {len(res)} match{'' if len(res) == 1 else 'es'} for “{args['query']}”" + (": " + ", ".join(e["path"] for e in res[:3]) if res else ""))

    @reg.tool("drive.read_text", "Read a UTF-8 text file from a shared folder.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _PATH,
                                                "max_bytes": {"type": "integer", "minimum": 1, "maximum": 1_000_000}},
               "required": ["grant", "path"], "additionalProperties": False}, "read", "drive")
    def read_text(args, ctx):
        r = core.call("fs.read_text", **{"max_bytes": 200_000, **args})
        return ToolResult({"content": r["content"], "truncated": r["truncated"]}, untrusted=True, source=f"file {args['path']}",
                          summary=f"Read {args['path']} ({len(r['content'])} characters{', truncated' if r['truncated'] else ''})")

    @reg.tool("drive.write_text", "Create or overwrite a text file. Overwrites are backed up automatically.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _PATH, "content": {"type": "string"},
                                                "overwrite": {"type": "boolean"}},
               "required": ["grant", "path", "content"], "additionalProperties": False}, "write", "drive")
    def write_text(args, ctx):
        r = core.call("fs.write_text", **args)
        return ToolResult({"written": r["path"], "size": r["size"], "backed_up": bool(r.get("backup"))},
                          summary=f"Saved {r['path']}" + (" (previous version backed up)" if r.get("backup") else ""))

    @reg.tool("drive.make_folder", "Create a folder (and parents) inside a shared folder.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _PATH}, "required": ["grant", "path"],
               "additionalProperties": False}, "write", "drive")
    def make_folder(args, ctx):
        p = core.call("fs.mkdir", **args)["path"]
        return ToolResult({"created": p}, summary=f"Created folder {p}")

    @reg.tool("drive.move", "Move or rename a file within the same shared folder.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _PATH, "to": _PATH},
               "required": ["grant", "path", "to"], "additionalProperties": False}, "write", "drive")
    def move(args, ctx):
        p = core.call("fs.move", **args)["path"]
        return ToolResult({"moved_to": p}, summary=f"Moved {args['path']} to {p}")

    @reg.tool("drive.trash", "Move a file or folder to the Atlas trash. Always requires the user's approval.",
              {"type": "object", "properties": {"grant": _GRANT, "path": _PATH}, "required": ["grant", "path"],
               "additionalProperties": False}, "destructive", "drive")
    def trash(args, ctx):
        core.call("fs.trash", **with_token(args, ctx))
        return ToolResult({"trashed": args["path"]}, summary=f"Moved {args['path']} to the Atlas trash")
