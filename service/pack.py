"""The bridge to the trader-skill scripts. Runs them as subprocesses in the project
folder (where trader/ lives) so the bot and the scheduler use exactly the same
code and files as the chat. Nothing here places an order on its own: `place`
only calls tinvest.py order, which keeps all of its own gates.
"""

import datetime
import json
import os
import subprocess
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


class PackError(Exception):
    pass


class Pack(object):
    def __init__(self, project_dir, pack_dir=None, runner=None):
        self.project = os.path.abspath(project_dir)
        self.pack = os.path.abspath(pack_dir or os.path.join(ROOT, "trader-skill"))
        self.runner = runner or self._run
        self.lock = threading.RLock()  # one script at a time: they share trader/ files

    # ------------------------------------------------------------ running
    def script(self, skill, name):
        path = os.path.join(self.pack, skill, name)
        if not os.path.isfile(path):
            raise PackError("script not found: %s" % path)
        return path

    def _run(self, argv, timeout=300):
        env = dict(os.environ, PYTHONIOENCODING="utf-8")
        try:
            p = subprocess.run([sys.executable] + argv, cwd=self.project, capture_output=True,
                               timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            return 124, "", "timed out after %ss" % timeout
        return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")

    def run(self, skill, name, *args, **kw):
        with self.lock:
            return self.runner([self.script(skill, name)] + [str(a) for a in args], kw.get("timeout", 300))

    def run_json(self, skill, name, *args):
        code, out, err = self.run(skill, name, *args)
        try:
            return code, json.loads(out), err
        except ValueError:
            raise PackError("%s/%s did not return JSON (exit %d): %s" % (skill, name, code, (err or out).strip()[:400]))

    # ------------------------------------------------------------ files
    def path(self, rel):
        return os.path.join(self.project, rel)

    def read(self, rel, default=None):
        p = self.path(rel)
        if not os.path.exists(p):
            return default
        with open(p, encoding="utf-8") as fh:
            try:
                return json.load(fh)
            except ValueError:
                return default

    def write(self, rel, doc):
        p = self.path(rel)
        d = os.path.dirname(p)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
        os.replace(tmp, p)

    def config(self):
        return self.read("trader/config.json", {}) or {}

    # ------------------------------------------------------------ the pack
    def tickets(self):
        """trader-broker: every ticket as JSON (needs a risk check first)."""
        code, doc, err = self.run_json("trader-broker", "ticket.py", "show", "--json")
        return doc if isinstance(doc, list) else [doc]

    def ticket(self, index):
        code, doc, err = self.run_json("trader-broker", "ticket.py", "show", "--json", "--index", index)
        return doc

    def risk(self):
        """trader-risk: check every proposed order, record the verdicts."""
        return self.run_json("trader-risk", "check.py", "--json")

    def approve(self, index, reply, via):
        return self.run("trader-broker", "ticket.py", "approve", "--index", index, "--reply", reply, "--via", via)

    def decline(self, index, reply):
        return self.run("trader-broker", "ticket.py", "decline", "--index", index, "--reply", reply)

    def place(self, index):
        """trader-tinvest: send ONE approved order. Its own three gates apply."""
        return self.run("trader-tinvest", "tinvest.py", "order", "--index", index)

    def log_today(self):
        return self.run("trader-broker", "ticket.py", "log")

    def quote(self, tickers=()):
        return self.run("trader-tinvest", "tinvest.py", "quote", *(list(tickers) + ["--write"]))

    def portfolio(self):
        return self.run("trader-tinvest", "tinvest.py", "portfolio", "--write")

    def whoami(self):
        return self.run("trader-tinvest", "tinvest.py", "whoami")

    def active_orders(self):
        return self.run("trader-tinvest", "tinvest.py", "orders")

    def alerts_check(self):
        code, out, err = self.run("trader-alerts", "alerts.py", "check", "--source", "file", "--json")
        try:
            return json.loads(out)
        except ValueError:
            return {"rings": [], "errors": [(err or out).strip()[:300] or "alerts.py failed"]}

    INBOX = "trader/inbox/targets.json"

    def take_inbox_targets(self):
        """A targets.json dropped into trader/inbox/ by the analyst becomes trader/targets.json.
        The previous one is kept as targets.prev.json. Returns the source note or None."""
        src = self.path(self.INBOX)
        if not os.path.isfile(src):
            return None
        doc = self.read(self.INBOX)
        if not isinstance(doc, dict) or "weights" not in doc:
            raise PackError("%s is not a targets file (needs \"weights\")" % self.INBOX)
        dst = self.path("trader/targets.json")
        if os.path.exists(dst):
            os.replace(dst, self.path("trader/targets.prev.json"))
        doc.setdefault("source", "inbox")
        doc["taken_at"] = datetime.datetime.now().replace(microsecond=0).isoformat()
        self.write("trader/targets.json", doc)
        os.remove(src)
        return str(doc.get("source", "inbox"))

    def size(self, budget=None):
        args = ["--write"] + (["--budget", budget] if budget else [])
        if os.path.exists(self.path("trader/prices.json")):
            args += ["--prices", "trader/prices.json"]  # whole shares need prices
        return self.run("trader-budget", "size.py", *args)

    def rebalance(self, band=None):
        args = ["--write"] + (["--band", band] if band else [])
        return self.run("trader-rebalance", "rebalance.py", *args)

    # ------------------------------------------------------------ halt switch
    HALT = "trader/state/halt.json"

    def halted(self):
        return self.read(self.HALT)

    def halt(self, reason, by):
        doc = {"at": datetime.datetime.now().replace(microsecond=0).isoformat(), "reason": reason, "by": str(by)}
        self.write(self.HALT, doc)
        return doc

    def resume(self):
        p = self.path(self.HALT)
        if os.path.exists(p):
            os.remove(p)
            return True
        return False
