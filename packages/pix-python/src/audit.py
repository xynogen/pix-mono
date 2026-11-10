"""Cooperative filesystem audit hook, not a sandbox (native calls/children can bypass it)."""
import json
import os
import socket
import sys
import threading


def install(port, token):
    lock = threading.RLock()
    local = threading.local()

    def path(value, directory=None):
        if isinstance(value, int):
            if sys.platform.startswith("linux"):
                return os.readlink("/proc/self/fd/" + str(value))
            raise PermissionError("Path gate cannot resolve file descriptors on this platform")
        value = os.fsdecode(value)
        if not os.path.isabs(value) and directory not in (None, -1):
            value = os.path.join(path(directory), value)
        return value if os.path.isabs(value) else os.path.join(os.getcwd(), value)

    def check(value, op, directory=None):
        target = path(value, directory)
        paths = list(dict.fromkeys([os.path.abspath(target), os.path.realpath(target)]))
        # Directory rules also apply when listing/removing the directory itself.
        paths += [p.rstrip("/\\") + "/" for p in paths]
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=30) as connection:
                connection.settimeout(None)
                connection.sendall((json.dumps({"token": token, "paths": paths, "op": op}) + "\n").encode())
                with connection.makefile("rb") as response:
                    raw = response.readline(65537)
                if len(raw) > 65536 or not raw.endswith(b"\n"):
                    raise ValueError("Invalid path gate response")
                decision = json.loads(raw)
                if decision.get("approved") is not True:
                    raise PermissionError(decision.get("reason", "Path access denied") + ": " + target)
        except (OSError, ValueError) as error:
            raise PermissionError("Path gate: " + str(error)) from error

    def audit(event, args):
        if getattr(local, "checking", False):
            return
        with lock:
            local.checking = True
            try:
                if event == "open":
                    flags = args[2]
                    writing = flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC)
                    check(args[0], "write" if writing else "read")
                    if flags & os.O_RDWR:
                        check(args[0], "read")
                elif event in ("os.listdir", "os.scandir", "os.chdir"):
                    check(args[0] if args[0] is not None else os.getcwd(), "read")
                elif event in ("os.remove", "os.rmdir"):
                    check(args[0], "write", args[1])
                elif event in ("os.mkdir", "os.chmod"):
                    check(args[0], "write", args[2])
                elif event in ("os.chown", "os.utime"):
                    check(args[0], "write", args[3])
                elif event == "os.truncate":
                    check(args[0], "write")
                elif event in ("os.rename", "os.link"):
                    check(args[0], "write" if event == "os.rename" else "read", args[2])
                    check(args[1], "write", args[3])
                elif event == "os.symlink":
                    check(args[1], "write", args[2])
            finally:
                local.checking = False

    sys.addaudithook(audit)


install(int(sys.argv[1]), sys.argv[2])
source = sys.stdin.read()
sys.argv = ["-"]
sys.path[0] = ""
namespace = sys.modules["__main__"].__dict__
namespace["__file__"] = "<stdin>"
exec(compile(source, "<stdin>", "exec"), namespace)
