#!/usr/bin/env python3
"""Deterministic fake LLM endpoint for reproducing pi / pi-async scenarios.

Speaks enough of the OpenAI-compatible surface that pi's `any-endpoint`
provider can drive it, so every test run gets byte-identical model output and
tool calls. No network, no cost, no model nondeterminism.

Script a conversation by passing a JSON file of turns; each request pops the
next scripted turn. A turn is either plain text or a sequence of tool calls.

Usage:
    mock-llm.py --port 3999 --script scenario.json
    pi --model any-endpoint/mock-model ...   # with baseUrl pointing here

scenario.json:
    {
      "turns": [
        {"text": "Sure, starting the task."},
        {"tools": [{"name": "async_run", "arguments": {"command": "echo HI", "mode": "background"}}]},
        {"text": "The task finished."}
      ]
    }

Requests beyond the script fall back to the last turn so a session never hangs.
"""
import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

INDEX = 0
SCRIPT = {"turns": [{"text": "mock response"}]}
LOG_PATH = None


def resolve_placeholder(value, last_task_id):
    """Replace $LAST_TASK_ID with the taskId from the previous tool result.

    Scenarios need to act on an id that only exists at runtime (e.g. call
    async_kill on the task async_run just created), so allow the scripts to be
    written without knowing the id in advance.
    """
    if isinstance(value, str):
        return value.replace("$LAST_TASK_ID", last_task_id or "")
    if isinstance(value, dict):
        return {k: resolve_placeholder(v, last_task_id) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_placeholder(v, last_task_id) for v in value]
    return value


def extract_last_task_id(request: dict) -> str | None:
    """Pull taskId out of the most recent tool result, if any."""
    for message in reversed(request.get("messages", [])):
        if message.get("role") != "tool":
            continue
        content = message.get("content")
        if isinstance(content, list):
            content = " ".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
        if not isinstance(content, str):
            continue
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and isinstance(parsed.get("taskId"), str):
            return parsed["taskId"]
    return None


def next_turn() -> dict:
    global INDEX
    turns = SCRIPT.get("turns", [])
    if not turns:
        return {"text": "ack"}
    if INDEX >= len(turns):
        # A session can be woken again after the script ends (e.g. by an
        # async-task notification). Repeating the last turn produces duplicate
        # text that looks like a product bug, so answer with a neutral ack.
        return {"text": SCRIPT.get("exhaustedText", "ack")}
    turn = turns[INDEX]
    INDEX += 1
    return turn


def sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj)}\n\n".encode()


def build_chunks(turn: dict, model: str):
    """Yield OpenAI chat.completion.chunk payloads for one scripted turn."""
    base = {"id": "chatcmpl-mock", "object": "chat.completion.chunk", "created": int(time.time()), "model": model}
    yield {**base, "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]}

    for i, call in enumerate(turn.get("tools", [])):
        yield {
            **base,
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "tool_calls": [
                            {
                                "index": i,
                                "id": f"call_mock_{i}",
                                "type": "function",
                                "function": {
                                    "name": call["name"],
                                    "arguments": json.dumps(call.get("arguments", {})),
                                },
                            }
                        ]
                    },
                    "finish_reason": None,
                }
            ],
        }

    text = turn.get("text")
    if text:
        for piece in [text[i : i + 24] for i in range(0, len(text), 24)]:
            yield {**base, "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]}

    finish = "tool_calls" if turn.get("tools") else "stop"
    yield {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _log(self, entry: dict):
        if LOG_PATH:
            with open(LOG_PATH, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            body = json.dumps(
                {
                    "object": "list",
                    "data": [
                        {
                            "id": "mock-model",
                            "object": "model",
                            "display_name": "Mock Model",
                            "context_window": 128000,
                            "max_output_tokens": 8192,
                            "modalities": {"input": ["text"], "output": ["text"]},
                        }
                    ],
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            request = {}
        self._log({"path": self.path, "request": request})

        model = request.get("model", "mock-model")
        turn = next_turn()
        last_task_id = extract_last_task_id(request)
        turn = resolve_placeholder(turn, last_task_id)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for chunk in build_chunks(turn, model):
            self.wfile.write(sse(chunk))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def main() -> int:
    global SCRIPT, LOG_PATH
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3999)
    ap.add_argument("--script")
    ap.add_argument("--log")
    args = ap.parse_args()

    if args.script:
        SCRIPT = json.load(open(args.script, encoding="utf-8"))
    LOG_PATH = args.log

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"mock-llm listening on 127.0.0.1:{args.port}", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
