#!/usr/bin/env python3
"""
Bridges a real PTY-backed shell to plain byte streams on stdin/stdout, so a
process that can only talk pipes (Bun's child_process) can still drive an
interactive shell (readline, job control, colors, `vim`/`less`, etc.).

stdin protocol (frames written by the parent process): a 1-byte type tag,
then a 4-byte big-endian length, then that many bytes of payload.
  type 0 (data):   payload is written straight to the PTY master.
  type 1 (resize): 4-byte payload, two big-endian uint16s: cols, rows.

stdout: raw bytes read from the PTY master, unframed - the parent forwards
these directly to the browser, so xterm.js sees exactly what a real
terminal emulator would.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_size(master_fd: int, cols: int, rows: int) -> None:
    try:
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def main() -> None:
    args = sys.argv[1:] or ["/bin/bash"]
    pid, master_fd = pty.fork()
    if pid == 0:
        os.execvp(args[0], args)
        os._exit(1)

    set_size(master_fd, 80, 24)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    stdin_buf = b""

    def dispatch_buffered() -> None:
        nonlocal stdin_buf
        while len(stdin_buf) >= 5:
            length = int.from_bytes(stdin_buf[1:5], "big")
            if len(stdin_buf) < 5 + length:
                return
            msg_type = stdin_buf[0]
            payload = stdin_buf[5 : 5 + length]
            stdin_buf = stdin_buf[5 + length :]
            if msg_type == 0:
                try:
                    os.write(master_fd, payload)
                except OSError:
                    pass
            elif msg_type == 1 and len(payload) == 4:
                cols = int.from_bytes(payload[0:2], "big")
                rows = int.from_bytes(payload[2:4], "big")
                set_size(master_fd, cols, rows)

    open_fds = [stdin_fd, master_fd]
    while open_fds:
        try:
            readable, _, _ = select.select(open_fds, [], [])
        except InterruptedError:
            continue

        if master_fd in readable:
            try:
                data = os.read(master_fd, 65536)
            except OSError:
                data = b""
            if not data:
                # Shell exited and the PTY slave has no writers left.
                break
            try:
                os.write(stdout_fd, data)
            except OSError:
                break

        if stdin_fd in readable and stdin_fd in open_fds:
            try:
                chunk = os.read(stdin_fd, 65536)
            except OSError:
                chunk = b""
            if not chunk:
                # Parent closed our stdin (browser disconnected) - hang up
                # the shell rather than leaving it running unattended.
                try:
                    os.kill(pid, signal.SIGHUP)
                except OSError:
                    pass
                break
            stdin_buf += chunk
            dispatch_buffered()

    try:
        os.kill(pid, signal.SIGHUP)
    except OSError:
        pass


if __name__ == "__main__":
    main()
