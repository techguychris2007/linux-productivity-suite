"""In-process event bus. Every event the activity panel shows is emitted here by real execution."""

from __future__ import annotations

import itertools
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterator


@dataclass
class Event:
    seq: int
    task_id: str
    type: str
    data: dict[str, Any]
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {"seq": self.seq, "task_id": self.task_id, "type": self.type, "data": self.data, "ts": self.ts}


class EventBus:
    def __init__(self, max_events: int = 20_000) -> None:
        self._events: list[Event] = []
        self._cond = threading.Condition()
        self._seq = itertools.count(1)
        self._max = max_events

    def emit(self, task_id: str, type_: str, **data: Any) -> Event:
        with self._cond:
            ev = Event(next(self._seq), task_id, type_, data)
            self._events.append(ev)
            if len(self._events) > self._max:
                del self._events[: self._max // 2]
            self._cond.notify_all()
            return ev

    def since(self, after_seq: int, task_id: str | None = None) -> list[Event]:
        with self._cond:
            return [e for e in self._events if e.seq > after_seq and (task_id is None or e.task_id == task_id)]

    def stream(self, after_seq: int = 0, task_id: str | None = None, timeout: float = 15.0) -> Iterator[Event | None]:
        """Yield events as they happen; yields None on idle timeout (used for keep-alives)."""
        last = after_seq
        while True:
            with self._cond:
                pending = [e for e in self._events if e.seq > last and (task_id is None or e.task_id == task_id)]
                if not pending:
                    self._cond.wait(timeout)
                    pending = [e for e in self._events if e.seq > last and (task_id is None or e.task_id == task_id)]
            if not pending:
                yield None
                continue
            for e in pending:
                last = e.seq
                yield e
