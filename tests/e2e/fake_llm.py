#!/usr/bin/env python3
"""TEST-ONLY fake OpenAI-compatible model server.

Deterministically drives Atlas AI through: plan → list folders → search → trash (needs approval) → summary,
and answers the verifier with PASS. Lets the E2E test exercise the real provider/tool/approval chain offline.
"""

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def reply(content=None, calls=None):
    msg = {"role": "assistant", "content": content}
    if calls:
        msg["tool_calls"] = [{"id": f"call_{name.replace('.', '_')}_{i}", "type": "function",
                              "function": {"name": name, "arguments": json.dumps(args)}} for i, (name, args) in enumerate(calls)]
    return {"choices": [{"message": msg, "finish_reason": "tool_calls" if calls else "stop"}]}


def first_user(msgs):
    return next((m["content"] for m in msgs if m["role"] == "user" and isinstance(m.get("content"), str)), "")


def decide(body):
    msgs = body["messages"]
    if not body.get("tools"):
        return reply("PASS")
    goal = first_user(msgs).lower()
    if "report" in goal:
        return writer_report(msgs)
    if "conclusion" in goal:
        return writer_conclusion(msgs)
    return trash_flow(msgs)


def called(msgs):
    return [c["function"]["name"] for m in msgs if m["role"] == "assistant" for c in (m.get("tool_calls") or [])]


def writer_report(msgs):
    names = called(msgs)
    text = " ".join(m["content"] for m in msgs if m["role"] == "tool")
    grant = (re.findall(r"g_[0-9a-f]{12}", text) or [None])[0]
    if "drive.list_folders" not in names:
        return reply(None, [("task.set_plan", {"steps": ["Pick a folder", "Write the report", "Export it to Word"]}), ("drive.list_folders", {})])
    if "writer.create_document" not in names:
        return reply(None, [("writer.create_document", {"grant": grant, "path": "Project report", "title": "Project report", "blocks": [
            {"type": "heading1", "text": "Summary"},
            {"type": "paragraph", "text": "Atlas reached **Milestone 3**: the Writer app now edits, imports and exports documents."},
            {"type": "heading1", "text": "Highlights"},
            {"type": "bullet", "text": "Block editor with styles, lists and tables"},
            {"type": "bullet", "text": "DOCX, PDF and ODT export through LibreOffice"},
            {"type": "table", "rows": [["Area", "Status"], ["Writer", "MVP"], ["Sheets", "Next"]]}]})])
    if "writer.export" not in names:
        return reply(None, [("writer.export", {"grant": grant, "path": "Project report.atlasdoc", "format": "docx"})])
    return reply("I wrote **Project report** in your Documents folder and exported a Word copy (Project report.docx).")


def writer_conclusion(msgs):
    names = called(msgs)
    system = next((m["content"] for m in msgs if m["role"] == "system"), "")
    m = re.search(r'"open_document": \{"grant": "(g_[0-9a-f]{12})", "path": "([^"]+)"', system)
    if not m:
        return reply("I can't see an open document.")
    grant, path = m.groups()
    if "writer.read_document" not in names:
        return reply(None, [("writer.read_document", {"grant": grant, "path": path})])
    if "writer.insert_blocks" not in names:
        n = len(re.findall(r'\\?"index\\?": ', " ".join(x["content"] for x in msgs if x["role"] == "tool")))
        return reply(None, [("writer.insert_blocks", {"grant": grant, "path": path, "after": max(n - 1, 0),
                                                       "blocks": [{"type": "heading1", "text": "Conclusion"},
                                                                  {"type": "paragraph", "text": "Writing in Atlas is fast and private."}]})])
    return reply("I added a Conclusion section at the end of your document.")


def trash_flow(msgs):
    tool_msgs = [m for m in msgs if m["role"] == "tool"]
    text = " ".join(m["content"] for m in tool_msgs)
    grant = (re.findall(r"g_[0-9a-f]{12}", text) or [None])[0]
    names = [c["function"]["name"] for m in msgs if m["role"] == "assistant" for c in (m.get("tool_calls") or [])]
    if "drive.list_folders" not in names:
        return reply(None, [("task.set_plan", {"steps": ["Find the shared folder", "Locate the notes file", "Move it to the trash"]}),
                            ("drive.list_folders", {})])
    if "drive.search" not in names:
        return reply(None, [("task.update_step", {"index": 0, "status": "done"}), ("drive.search", {"grant": grant, "query": "notes"})])
    if "drive.trash" not in names:
        return reply(None, [("task.update_step", {"index": 1, "status": "done"}), ("drive.trash", {"grant": grant, "path": "notes.txt"})])
    if "drive.trash" in names and names.count("task.update_step") < 3:
        return reply(None, [("task.update_step", {"index": 2, "status": "done"})])
    return reply("I moved notes.txt from your Documents folder to the Atlas trash. You can restore it from the trash at any time.")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        out = json.dumps(decide(body)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
