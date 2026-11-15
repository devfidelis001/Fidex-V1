"""Research & Problem Solving engine (Start Solving World Problems).

A research run is a real, iterative workflow. Nothing here is simulated:

  1. PLAN      the local AI (Ollama) proposes web search queries for the problem and focus area
  2. SEARCH    every query is sent to a real web search (DuckDuckGo, Wikipedia as a second source)
  3. READ      the best pages are downloaded and their text is extracted
  4. EXTRACT   the AI pulls findings out of each page; every finding must quote text that is really on that page
  5. ITERATE   the AI checks what is still missing and runs a second round of searches for the gaps
  6. ANALYSE   causes, solution comparison, recommendation and an implementation plan - written only from the
               collected findings, citing sources by number

Progress is a list of "activities" that is created while the work happens (one per search, per page read, per
AI step). The UI shows that list as it changes. If the web cannot be reached, the run says so and the report is
marked as NOT based on web sources - it never claims research that did not happen.

Everything on the network goes through small functions (_web_search, _fetch_page) so tests can replace them.
"""
from __future__ import annotations

import html
import ipaddress
import json
import logging
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from html.parser import HTMLParser

from . import ai
from .handlers import emit
from .protocol import INVALID_PAYLOAD, NOT_FOUND, RequestError

log = logging.getLogger("fidex.research")

FOCUS = {
    "jobs": "Jobs: roles in demand, required skills, employers, hiring channels, pay, how to get hired or hire.",
    "advertisement": "Advertisement: audience, channels, budget, message and creative, costs, measurable results.",
    "health": "Health: causes, who is affected, access to care, prevention, what has worked elsewhere.",
    "climate": "Climate: emissions, local impacts, adaptation, policies and practical actions.",
    "education": "Education: access, quality, costs, learning outcomes, practical programs.",
    "energy": "Energy: supply, cost, clean alternatives, access, practical options.",
    "water": "Water and food: access, safety, supply chains, farming, practical options.",
    "economy": "Economy: income, businesses, costs, policy, practical options.",
    "any": "Other problem: root causes, who is affected, what has worked elsewhere, practical options.",
}
MAX_PROBLEM = 1500
MAX_QUERIES_ROUND = 3
MAX_ROUNDS = 2
MAX_PAGES = 4
FAST_ROUND_SECS = 80  # fast mode: no follow-up round once this much time has passed, so research ends in about 3 minutes
BUDGET_SECS = 200  # web research stops after this long, then the analysis is written from what was found
PAGE_BYTES = 400_000
PAGE_CHARS = 5000  # text kept per page
EXCERPT_CHARS = 1600  # what the AI reads of one page
FETCH_TIMEOUT = 8
MAX_RUNS = 20
USER_AGENT = "Mozilla/5.0 (compatible; FIDEXResearch/1.0)"
_OPENER = urllib.request.build_opener()  # normal system proxy settings apply to the open web (unlike local Ollama)


# ---------- web access (replaceable in tests) ----------
class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form", "iframe", "aside"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.title, self._skip, self._in_title = [], "", 0, False

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag == "title":
            self._in_title = True
        elif tag in ("p", "br", "li", "h1", "h2", "h3", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self._skip:
            self._skip -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip and data.strip():
            self.parts.append(data.strip() + " ")


def _clean_text(raw: str) -> tuple[str, str]:
    p = _Text()
    try:
        p.feed(raw)
    except Exception:  # noqa: BLE001  (broken HTML: use what was parsed)
        pass
    text = re.sub(r"[ \t]+", " ", "".join(p.parts))
    text = re.sub(r"\s*\n\s*", "\n", text).strip()
    return " ".join(p.title.split())[:160], text


def _public_url(url: str) -> bool:
    """Only http(s) pages on the public internet are fetched (never localhost or private networks)."""
    try:
        u = urllib.parse.urlparse(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            return False
        for info in socket.getaddrinfo(u.hostname, u.port or 443, proto=socket.IPPROTO_TCP):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except (OSError, ValueError):
        return False


def _http(url: str, data: bytes | None = None, timeout: float = FETCH_TIMEOUT) -> tuple[bytes, str]:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, "Accept-Language": "en"})
    with _OPENER.open(req, timeout=timeout) as resp:
        ctype = resp.headers.get("Content-Type", "")
        return resp.read(PAGE_BYTES), ctype


def _ddg_search(query: str) -> list[dict]:
    body, _ = _http("https://html.duckduckgo.com/html/", urllib.parse.urlencode({"q": query}).encode())
    page = body.decode("utf-8", "replace")
    out = []
    for m in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', page, re.S):
        href, title = html.unescape(m.group(1)), re.sub(r"<.*?>", "", html.unescape(m.group(2))).strip()
        q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
        if "uddg" in q:
            href = q["uddg"][0]
        if href.startswith("//"):
            href = "https:" + href
        if href.startswith("http") and title:
            out.append({"title": title[:160], "url": href})
    return out


def _wiki_search(query: str) -> list[dict]:
    url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode({"action": "query", "list": "search", "srsearch": query, "srlimit": 3, "format": "json"})
    body, _ = _http(url)
    items = json.loads(body.decode("utf-8", "replace")).get("query", {}).get("search", [])
    return [{"title": i["title"], "url": "https://en.wikipedia.org/wiki/" + urllib.parse.quote(i["title"].replace(" ", "_"))} for i in items]


def _web_search(query: str) -> list[dict]:
    """Real web search. Returns [{title, url}]; raises OSError when no search engine can be reached."""
    results, failed = [], 0
    for fn in (_ddg_search, _wiki_search):
        try:
            results += fn(query)
        except (OSError, ValueError, urllib.error.URLError) as err:
            failed += 1
            log.info("search provider %s failed: %s", fn.__name__, err)
    if failed == 2:
        raise OSError("no search engine could be reached")
    return results


def _fetch_page(url: str) -> dict:
    """Downloads one page. Returns {title, text}; raises OSError if it cannot be read."""
    if not _public_url(url):
        raise OSError("not a public web page")
    body, ctype = _http(url)
    if ctype and "html" not in ctype and "text" not in ctype:
        raise OSError("not a text page")
    title, text = _clean_text(body.decode("utf-8", "replace"))
    if len(text) < 200:
        raise OSError("page has too little readable text")
    return {"title": title, "text": text[:PAGE_CHARS]}


# ---------- AI steps ----------
def _ask_json(system: str, user: str, num_predict: int = 900):
    """One AI call that must return JSON. Returns the parsed value, or None if the AI could not (never invents)."""
    body = {
        "model": ai.model(), "stream": False, "think": False, "format": "json", "keep_alive": ai.KEEP_ALIVE,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "options": {**ai._options(False), "num_predict": num_predict, "temperature": 0.3},
    }
    with ai._gen_lock:  # one generation at a time, shared with normal chat
        result = ai._call("/api/chat", body, ai._timeout())
    text = ((result.get("message") or {}).get("content") or "") if isinstance(result, dict) else ""
    text = ai._THINK_RE.sub("", text).strip()
    try:
        return json.loads(text)
    except ValueError:
        m = re.search(r"[\[{].*[\]}]", text, re.S)
        try:
            return json.loads(m.group(0)) if m else None
        except ValueError:
            return None


def _strs(v, n, limit=240) -> list[str]:
    if not isinstance(v, list):
        return []
    return [" ".join(x.split())[:limit] for x in v if isinstance(x, str) and x.strip()][:n]


def _heuristic_queries(problem: str, focus: str) -> list[str]:
    base = " ".join(problem.split())[:110]
    extra = {"jobs": "jobs skills hiring", "advertisement": "advertising strategy channels cost", "any": "causes solutions"}[focus]
    return [base, f"{base} {extra}"[:140]]


# ---------- run state ----------
class Run:
    def __init__(self, problem: str, focus: str):
        self.id = uuid.uuid4().hex[:12]
        self.problem, self.focus = problem, focus
        self.status = "running"  # running | done | failed | cancelled
        self.started = time.time()
        self.activities: list[dict] = []
        self.sources: list[dict] = []
        self.findings: list[dict] = []
        self.report: dict | None = None
        self.error: str | None = None
        self.notes: list[str] = []
        self.web_ok = False
        self.build: dict | None = None  # {status: running|done|failed, html, error}
        self.extra: list[str] = []  # things the person told the AI while it works
        self.paused = False  # the person left: wait until they are back
        self.paused_total = 0.0
        self._paused_at = 0.0
        self.cancel = threading.Event()
        self.finish = threading.Event()  # "wrap up now": stop gathering, write the analysis
        self._lock = threading.RLock()
        self._n = 0

    # activities --------------------------------------------------
    def add(self, kind: str, title: str, detail: str = "", state: str = "pending") -> dict:
        with self._lock:
            self._n += 1
            a = {"id": self._n, "kind": kind, "title": title, "detail": detail, "state": state, "result": "", "started": time.time() if state == "active" else None, "finished": None}
            self.activities.append(a)
        self.publish()
        return a

    def set(self, a: dict, state: str | None = None, detail: str | None = None, result: str | None = None, title: str | None = None) -> None:
        with self._lock:
            if title is not None:
                a["title"] = title
            if detail is not None:
                a["detail"] = detail
            if result is not None:
                a["result"] = result
            if state is not None:
                if state == "active" and not a["started"]:
                    a["started"] = time.time()
                if state in ("done", "failed", "skipped") and not a["finished"]:
                    a["finished"] = time.time()
                a["state"] = state
        self.publish()

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "run_id": self.id, "problem": self.problem, "focus": self.focus, "status": self.status, "started": self.started,
                "web_ok": self.web_ok, "paused": self.paused, "activities": [dict(a) for a in self.activities], "sources": [{k: v for k, v in s.items() if k != "excerpt"} for s in self.sources],
                "findings": [dict(f) for f in self.findings], "report": self.report, "build": dict(self.build) if self.build else None, "error": self.error, "notes": list(self.notes),
            }

    def publish(self) -> None:
        emit("research.event", self.snapshot())

    def extra_text(self) -> str:
        with self._lock:
            return ("\nExtra instructions from the user (follow them):\n" + "\n".join(f"- {x}" for x in self.extra)) if self.extra else ""

    def check(self) -> None:
        while self.paused and not self.cancel.is_set():
            time.sleep(0.5)
        if self.cancel.is_set():
            raise _Cancelled()

    def set_paused(self, on: bool) -> None:
        with self._lock:
            if on and not self.paused:
                self.paused, self._paused_at = True, time.time()
            elif not on and self.paused:
                self.paused = False
                self.paused_total += time.time() - self._paused_at
        self.publish()

    def check_time(self) -> None:
        self.check()
        if self.finish.is_set() or time.time() - self.started - self.paused_total > BUDGET_SECS:
            raise _OutOfTime()


class _Cancelled(Exception):
    pass


class _OutOfTime(Exception):
    pass


_runs: dict[str, Run] = {}
_runs_lock = threading.Lock()


# ---------- the workflow ----------
def _source_no(run: Run, url: str, title: str) -> dict:
    for s in run.sources:
        if s["url"] == url:
            return s
    s = {"n": len(run.sources) + 1, "url": url, "title": title or url, "domain": urllib.parse.urlparse(url).netloc.removeprefix("www."), "read": False, "excerpt": ""}
    run.sources.append(s)
    return s


def _search_round(run: Run, queries: list[str], seen: set[str]) -> list[dict]:
    """Runs the queries (each is its own activity) and returns new candidate pages."""
    cands: list[dict] = []
    acts = [(q, run.add("search", f"Search the web: {q}", "Waiting")) for q in queries]
    for q, a in acts:
        run.check_time()
        run.set(a, "active", "Searching...")
        try:
            hits = _web_search(q)
        except OSError as err:
            run.set(a, "failed", "Search engine not reachable", str(err))
            continue
        run.web_ok = True
        new = [h for h in hits if h["url"] not in seen][:5]
        for h in new:
            seen.add(h["url"])
        cands += new
        run.set(a, "done", f"{len(hits)} results, {len(new)} new", "; ".join(h["title"] for h in new[:3]))
    return cands


def _read_pages(run: Run, cands: list[dict], limit: int) -> list[dict]:
    pages = []
    todo = []
    for c in cands[: limit + 3]:
        todo.append((c, run.add("read", f"Read: {c['title'][:70]}", urllib.parse.urlparse(c["url"]).netloc)))
    for c, a in todo:
        run.check_time()
        if len(pages) >= limit:
            run.set(a, "skipped", "Enough pages read")
            continue
        run.set(a, "active", "Downloading and reading...")
        try:
            page = _fetch_page(c["url"])
        except (OSError, ValueError, urllib.error.URLError) as err:
            run.set(a, "failed", "Could not read this page", str(err))
            continue
        src = _source_no(run, c["url"], page["title"] or c["title"])
        src["read"], src["excerpt"] = True, page["text"]
        pages.append({"src": src, "text": page["text"]})
        run.set(a, "done", f"{len(page['text'])} characters read", f"[{src['n']}] {src['title'][:80]}")
    return pages


def _extract(run: Run, pages: list[dict]) -> None:
    for pg in pages:
        run.check_time()
        src = pg["src"]
        a = run.add("extract", f"Extract findings from [{src['n']}] {src['domain']}", "Reading the page", "active")
        data = _ask_json(
            "You extract facts for a research task. Use ONLY the page text given. Reply as JSON: "
            '{"findings":[{"fact":"one specific fact in your own words","quote":"an exact short quote copied from the text"}]}. '
            "At most 3 findings. If the page is not relevant, return an empty list.",
            f"Problem: {run.problem}{run.extra_text()}\nFocus: {FOCUS[run.focus]}\n\nPage text:\n{pg['text'][:EXCERPT_CHARS]}",
        )
        got = 0
        items = data.get("findings") if isinstance(data, dict) else None
        for it in (items if isinstance(items, list) else [])[:3]:
            if not isinstance(it, dict) or not isinstance(it.get("fact"), str):
                continue
            quote = " ".join(str(it.get("quote") or "").split())
            verified = bool(quote) and len(quote) >= 12 and quote.lower() in " ".join(pg["text"].split()).lower()  # the quote must really be on the page
            run.findings.append({"text": " ".join(it["fact"].split())[:300], "source": src["n"], "quote": quote[:240] if verified else "", "verified": verified})
            got += 1
        run.set(a, "done" if data is not None else "failed", f"{got} finding(s)" if data is not None else "The AI did not return findings for this page", "")


def _gaps(run: Run) -> list[str]:
    facts = "\n".join(f"- {f['text']}" for f in run.findings[:12])
    data = _ask_json(
        'You review research progress. Reply as JSON: {"missing":"what is still unknown","queries":["1 or 2 new web search queries that would fill the gap"]}.',
        f"Problem: {run.problem}{run.extra_text()}\nFocus: {FOCUS[run.focus]}\nFindings so far:\n{facts or '(none)'}",
        300,
    )
    return _strs(data.get("queries"), 2, 110) if isinstance(data, dict) else []


def _cite(run: Run, nums) -> list[int]:
    valid = {s["n"] for s in run.sources if s["read"]}
    return [n for n in (nums if isinstance(nums, list) else []) if isinstance(n, int) and n in valid][:4]


def _synthesise(run: Run) -> None:
    if not run.findings:
        a = run.add("analyse", "Analyse causes", "", "failed")
        run.set(a, "failed", "No findings to analyse", "No usable information was collected, so no analysis was written.")
        return
    facts = "\n".join(f"[{f['source']}] {f['text']}" for f in run.findings[:18])
    ctx = f"Problem: {run.problem}{run.extra_text()}\nFocus: {FOCUS[run.focus]}\nFindings (number = source):\n{facts}"
    rules = "Use ONLY the findings above. Cite source numbers as integers. If the findings do not support something, leave it out."
    report: dict = {"summary": "", "causes": [], "solutions": [], "recommendation": None, "plan": []}

    a = run.add("analyse", "Analyse causes from the findings", "", "active")
    d = _ask_json(f'Reply as JSON: {{"summary":"3 sentence summary","causes":[{{"cause":"","explanation":"","sources":[1]}}]}}. {rules} At most 4 causes.', ctx)
    if isinstance(d, dict):
        report["summary"] = str(d.get("summary") or "")[:700]
        for c in (d.get("causes") if isinstance(d.get("causes"), list) else [])[:4]:
            if isinstance(c, dict) and isinstance(c.get("cause"), str):
                report["causes"].append({"cause": c["cause"][:160], "explanation": str(c.get("explanation") or "")[:400], "sources": _cite(run, c.get("sources"))})
    run.set(a, "done" if report["causes"] else "failed", f"{len(report['causes'])} cause(s) identified" if report["causes"] else "The AI could not identify causes from the findings")
    run.check()

    a = run.add("solutions", "Compare possible solutions", "", "active")
    d = _ask_json(f'Reply as JSON: {{"solutions":[{{"name":"","description":"","pros":[""],"cons":[""],"effort":"low|medium|high","impact":"low|medium|high","sources":[1]}}]}}. {rules} 2 to 4 solutions.', ctx + "\nCauses: " + "; ".join(c["cause"] for c in report["causes"]))
    for s in (d.get("solutions") if isinstance(d, dict) and isinstance(d.get("solutions"), list) else [])[:4]:
        if isinstance(s, dict) and isinstance(s.get("name"), str):
            lvl = lambda v: v if v in ("low", "medium", "high") else "medium"  # noqa: E731
            report["solutions"].append({"name": s["name"][:100], "description": str(s.get("description") or "")[:400], "pros": _strs(s.get("pros"), 3), "cons": _strs(s.get("cons"), 3), "effort": lvl(s.get("effort")), "impact": lvl(s.get("impact")), "sources": _cite(run, s.get("sources"))})
    run.set(a, "done" if report["solutions"] else "failed", f"{len(report['solutions'])} option(s) compared" if report["solutions"] else "The AI could not compare solutions")
    run.check()

    if report["solutions"]:
        a = run.add("recommend", "Choose a recommendation", "", "active")
        opts = "\n".join(f"- {s['name']}: {s['description']} (effort {s['effort']}, impact {s['impact']})" for s in report["solutions"])
        d = _ask_json(f'Reply as JSON: {{"choice":"name of the best option","why":"2 sentences","sources":[1]}}. {rules}', ctx + "\nOptions:\n" + opts, 400)
        if isinstance(d, dict) and isinstance(d.get("choice"), str):
            report["recommendation"] = {"choice": d["choice"][:100], "why": str(d.get("why") or "")[:500], "sources": _cite(run, d.get("sources"))}
        run.set(a, "done" if report["recommendation"] else "failed", "Recommendation written" if report["recommendation"] else "The AI did not return a recommendation")
        run.check()

        a = run.add("plan", "Draft an implementation plan", "", "active")
        d = _ask_json(
            'Reply as JSON: {"steps":[{"step":"short action","detail":"how to do it"}]}. 4 to 7 concrete steps to carry out the recommended option. ' + rules,
            ctx + "\nRecommended: " + json.dumps(report["recommendation"] or report["solutions"][0]["name"]), 700,
        )
        for st in (d.get("steps") if isinstance(d, dict) and isinstance(d.get("steps"), list) else [])[:7]:
            if isinstance(st, dict) and isinstance(st.get("step"), str):
                report["plan"].append({"step": st["step"][:120], "detail": str(st.get("detail") or "")[:300]})
        run.set(a, "done" if report["plan"] else "failed", f"{len(report['plan'])} step(s)" if report["plan"] else "The AI did not return a plan")
    run.report = report


def _execute(run: Run) -> None:
    seen: set[str] = set()
    try:
        a = run.add("plan", "Plan the research", "Asking the AI which searches would answer this", "active")
        d = _ask_json(
            'You plan web research. Reply as JSON: {"queries":["3 specific web search queries"]}. Queries must be short, concrete and different from each other.',
            f"Problem: {run.problem}{run.extra_text()}\nFocus: {FOCUS[run.focus]}", 300,
        )
        queries = _strs(d.get("queries") if isinstance(d, dict) else None, MAX_QUERIES_ROUND, 110)
        if not queries:
            queries = _heuristic_queries(run.problem, run.focus)
            run.notes.append("The AI did not suggest search queries, so queries were built directly from your description.")
        run.set(a, "done", f"{len(queries)} searches planned", " | ".join(queries))
        run.check()

        pages: list[dict] = []
        try:
            for rnd in range(1, MAX_ROUNDS + 1):
                cands = _search_round(run, queries, seen)
                if rnd == 1 and not run.web_ok:
                    run.notes.append("No web search could be reached (check the internet connection). No sources were collected.")
                    break
                new_pages = _read_pages(run, cands, MAX_PAGES - len(pages))
                pages += new_pages
                _extract(run, new_pages)
                if rnd == MAX_ROUNDS or len(pages) >= MAX_PAGES or not run.findings or time.time() - run.started - run.paused_total > FAST_ROUND_SECS:
                    break
                a = run.add("review", f"Check what is still missing (round {rnd})", "", "active")
                queries = _gaps(run)
                if not queries:
                    run.set(a, "done", "Nothing important missing")
                    break
                run.set(a, "done", f"{len(queries)} follow-up search(es)", " | ".join(queries))
                run.check()

        except _OutOfTime:
            run.notes.append("The research time limit was reached, so the analysis uses what was found so far.")
            for a in run.activities:
                if a["state"] in ("pending", "active"):
                    run.set(a, "skipped", "Time limit reached")

        _synthesise(run)
        if not run.sources:
            run.notes.append("Nothing was found on the web, so there are no sources, evidence or resources.")
        run.check()
        run.status = "done" if (run.report and (run.report["causes"] or run.report["solutions"])) else "failed"
        if run.status == "failed":
            run.error = "The research could not produce results. " + (run.notes[-1] if run.notes else "See the activity list for what failed.")
    except _Cancelled:
        pass  # cancel() already ended the run
    except RequestError as err:  # the AI engine itself is unavailable
        run.status, run.error = "failed", err.message
        for a in run.activities:
            if a["state"] in ("pending", "active"):
                run.set(a, "failed", err.message)
    except Exception:  # noqa: BLE001  (a bug must end the run visibly, not leave it "running")
        log.exception("research run crashed")
        run.status, run.error = "failed", "The research stopped because of an unexpected error."
    finally:
        run.publish()


# ---------- public API ----------
def start(problem, focus) -> dict:
    if not isinstance(problem, str) or len(problem.strip()) < 8:
        raise RequestError(INVALID_PAYLOAD, "Describe the problem in a few words (at least 8 characters).")
    if focus not in FOCUS:
        raise RequestError(INVALID_PAYLOAD, f"'focus' must be one of: {', '.join(FOCUS)}.")
    run = Run(" ".join(problem.split())[:MAX_PROBLEM], focus)
    with _runs_lock:
        for rid in list(_runs)[: max(0, len(_runs) - MAX_RUNS + 1)]:
            _runs.pop(rid, None)
        _runs[run.id] = run
    threading.Thread(target=_execute, args=(run,), name="fidex-research", daemon=True).start()
    return {"run_id": run.id}


def get(run_id) -> Run:
    with _runs_lock:
        run = _runs.get(run_id) if isinstance(run_id, str) else None
    if not run:
        raise RequestError(NOT_FOUND, "That research run does not exist (it may be from before the app restarted).")
    return run


def add_note(run_id, text) -> dict:
    run = get(run_id)
    if not isinstance(text, str) or not text.strip():
        raise RequestError(INVALID_PAYLOAD, "Type something first.")
    text = " ".join(text.split())[:500]
    run.extra.append(text)
    a = run.add("review", "You said: " + text[:100], "The AI will use this in its next step", "done")
    run.set(a, "done")
    return {"run_id": run.id}


def pause(run_id, on) -> dict:
    run = get(run_id)
    if run.status == "running":
        run.set_paused(bool(on))
    return {"run_id": run.id, "paused": run.paused}


def finish(run_id) -> dict:
    run = get(run_id)
    run.finish.set()
    run.paused = False
    return {"run_id": run.id}


def cancel(run_id) -> dict:
    run = get(run_id)
    was = run.status == "running"
    run.cancel.set()
    if was:  # stop at once: the screen must not wait for a slow AI call to finish
        run.status = "cancelled"
        for a in run.activities:
            if a["state"] in ("pending", "active"):
                run.set(a, "skipped" if a["state"] == "pending" else "failed", "Stopped by you")
        run.publish()
    return {"run_id": run.id, "cancelling": was}


# ---------- build: write the website that solves the problem (only after the person allows it) ----------
def _build(run: Run, mine: dict) -> None:
    try:
        r = run.report or {}
        brief = json.dumps({"problem": run.problem, "summary": r.get("summary"), "causes": r.get("causes"), "recommendation": r.get("recommendation"), "plan": r.get("plan"), "user_instructions": run.extra})[:5000]
        d = _ask_json(
            'You are a web developer. Write ONE complete, self-contained HTML file (inline CSS and JS, no external files, no network calls) '
            'for a small website that helps solve the problem using the recommended solution and plan. Clean, responsive, usable design. '
            'Reply as JSON: {"html":"<!doctype html>..."}.',
            brief, 6000,
        )
        page = d.get("html") if isinstance(d, dict) else None
        if run.build is not mine:  # stopped or restarted while the AI was working
            return
        if isinstance(page, str) and "<html" in page.lower() and len(page) > 300:
            run.build = {"status": "done", "html": page, "error": None}
        else:
            run.build = {"status": "failed", "html": "", "error": "The AI did not return a usable website. Try again."}
    except RequestError as err:
        run.build = {"status": "failed", "html": "", "error": err.message}
    except Exception:  # noqa: BLE001
        log.exception("build crashed")
        run.build = {"status": "failed", "html": "", "error": "Building stopped because of an unexpected error."}
    finally:
        run.publish()


def build(run_id) -> dict:
    run = get(run_id)
    if run.status != "done":
        raise RequestError(INVALID_PAYLOAD, "Finish the research before building.")
    if run.build and run.build["status"] == "running":
        return {"run_id": run.id}
    run.build = {"status": "running", "html": "", "error": None}
    run.publish()
    threading.Thread(target=_build, args=(run, run.build), name="fidex-build", daemon=True).start()
    return {"run_id": run.id}


def build_stop(run_id) -> dict:
    run = get(run_id)
    if run.build and run.build["status"] == "running":
        run.build = {"status": "failed", "html": "", "error": "Building stopped by you."}
        run.publish()
    return {"run_id": run.id}
